# Builds a curated deck of movies/TV for one round of a game.
#
# Sourcing strategy: instead of raw TMDB popularity (franchise blockbusters,
# unreleased hype titles, junk on deep pages), each deck mixes quality pools:
#
#   recs      - TMDB recommendations seeded by the players' liked titles
#   popular   - current popular titles, filtered to well-rated and widely voted
#   gems      - highly rated but less-known titles ("hidden gems")
#   acclaimed - widely loved catalog picks across eras
#
# With no like history the deck is popular + gems + acclaimed. As players like
# titles, recommendations take a growing share. Titles any player has already
# liked, swiped past, or been dealt in recent games are excluded, so decks
# never repeat.
class DeckBuilder
  DECK_SIZE = 20
  CURATE_DECK_MAX = 40
  MAX_SEEDS = 6
  RECENT_GAMES_PER_PLAYER = 10
  RECENT_DEALT_GAMES = 15
  DOCUMENTARY_GENRE = 99
  FAMILY_GENRE = 10751
  KIDS_GENRE = 10762

  # Legacy TMDB IDs users may still have in saved prefs / game queries.
  PROVIDER_ID_ALIASES = {
    "2" => "350", # Apple TV Store → Apple TV
    "531" => "2303", # retired Paramount Plus → Paramount Plus Premium
  }.freeze

  def initialize(game)
    @game = game
    @query_params = parse_query_params
    @excluded_keys = excluded_media_keys
    @rng = Random.new(game.id * 31 + game.load_more_count)
  end

  def build
    curated = curated_candidates
    return curated.first(CURATE_DECK_MAX) if curated.any?

    recs = recommendation_candidates
    plan = if favor_popular?
      [
        [recs, [recs.size, personalized_target].min],
        [popular_candidates, 12],
        [hidden_gem_candidates, 2],
        [acclaimed_candidates, 2],
      ]
    else
      [
        [recs, [recs.size, personalized_target].min],
        [popular_candidates, 6],
        [hidden_gem_candidates, 4],
        [acclaimed_candidates, 4],
      ]
    end

    deck = interleave(plan)
    fill(deck, plan.map(&:first))
    fill(deck, [fallback_candidates]) if deck.size < DECK_SIZE
    deck.first(DECK_SIZE)
  end

  private

  def parse_query_params
    JSON.parse(@game.query.to_s)["params"] || {}
  rescue JSON::ParserError, TypeError
    {}
  end

  # Explicit title list for "narrow it down" sessions — re-swipe shared likes.
  def curated_keys
    @curated_keys ||= MediaKey.normalize_list(@query_params["ww_curate_keys"].to_s.split(/[,\s]+/))
  end

  def curated_candidates
    return [] if curated_keys.empty?

    curated_keys.filter_map do |key|
      media, id = MediaKey.parse(key)
      next if id <= 0

      item = TmdbClient.details(id, media: media)
      next if item.blank? || item["id"].blank?
      next if item["poster_path"].blank? || item["adult"]

      normalize(item, media)
    end.shuffle(random: @rng)
  end

  def favor_popular?
    ActiveModel::Type::Boolean.new.cast(@query_params["favor_popular"])
  end

  def exclude_kids?
    return false if ActiveModel::Type::Boolean.new.cast(@query_params["include_kids"])
    return true if ActiveModel::Type::Boolean.new.cast(@query_params["exclude_kids"])

    # Legacy games relied on without_genres alone.
    without = @query_params["without_genres"].to_s.split("|").map(&:to_i)
    without.include?(FAMILY_GENRE) || without.include?(KIDS_GENRE)
  end

  def media_types
    case @query_params["media_type"].to_s
    when "tv" then %w[tv]
    when "both" then %w[movie tv]
    else %w[movie]
    end
  end

  # More like-history means a bigger personalized share (max half the deck).
  def personalized_target
    [seed_refs.size * 2, DECK_SIZE / 2].min
  end

  # Players' liked titles, most-shared first, rotated per round so
  # "keep playing" seeds from different favorites.
  def seed_refs
    @seed_refs ||= begin
      like_counts = Hash.new(0)
      @game.players.map(&:user_id).uniq.each do |user_id|
        recent_likes = Player.where(user_id: user_id)
                             .order(updated_at: :desc)
                             .limit(RECENT_GAMES_PER_PLAYER)
                             .pluck(:liked_movie_ids)
                             .flatten
        MediaKey.normalize_list(recent_likes).uniq.each { |key| like_counts[key] += 1 }
      end

      like_counts.sort_by { |key, count| [-count, key] }
                 .map(&:first)
                 .rotate(@game.load_more_count * MAX_SEEDS)
                 .first(MAX_SEEDS)
    end
  end

  def recommendation_candidates
    scores = Hash.new(0)
    movies = {}

    seed_refs.each do |seed_key|
      media, seed_id = MediaKey.parse(seed_key)
      next if seed_id <= 0

      results = media == "tv" ? TmdbClient.tv_recommendations(seed_id) : TmdbClient.recommendations(seed_id)
      results.each do |item|
        movie = normalize(item, media)
        next unless suitable?(movie)
        next unless available_on_providers?(movie)
        next if movie["vote_count"].to_i < 150 || movie["vote_average"].to_f < 6.2

        scores[deck_key(movie)] += 1
        movies[deck_key(movie)] = movie
      end
    end

    scores.sort_by { |_, score| -score }.map { |key, _| movies[key] }
  end

  def popular_candidates
    @popular_candidates ||= discover_pool(
      "sort_by" => "popularity.desc",
      "vote_count.gte" => favor_popular? ? 800 : 400,
      "vote_average.gte" => 6.3,
      "page" => page_for(:popular, 3)
    )
  end

  def hidden_gem_candidates
    @hidden_gem_candidates ||= discover_pool(
      "sort_by" => "popularity.desc",
      "vote_average.gte" => 7.1,
      "vote_count.gte" => 500,
      "vote_count.lte" => 3000,
      "page" => page_for(:gems, 6)
    )
  end

  def acclaimed_candidates
    @acclaimed_candidates ||= discover_pool(
      "sort_by" => "vote_average.desc",
      "vote_count.gte" => 3000,
      "page" => page_for(:acclaimed, 8)
    )
  end

  def fallback_candidates
    discover_pool(
      "sort_by" => "popularity.desc",
      "vote_count.gte" => 100,
      "page" => page_for(:fallback, 2)
    )
  end

  def discover_pool(overrides)
    ranges = year_ranges
    ranges = [[nil, nil]] if ranges.empty?

    media_types.flat_map do |media|
      ranges.flat_map do |from, to|
        params = base_discover_params(media).merge(overrides)
        apply_year_range!(params, media, from, to)
        TmdbClient.discover(params, media: media)
                  .map { |item| normalize(item, media) }
                  .select { |movie| suitable?(movie) }
      end
    end.uniq { |movie| deck_key(movie) }
  end

  def base_discover_params(media)
    params = {
      "include_adult" => false,
      "with_genres" => @query_params["with_genres"],
      "without_genres" => @query_params["without_genres"],
      "with_watch_providers" => @query_params["with_watch_providers"],
      "watch_region" => @query_params["watch_region"],
      "with_original_language" => @query_params["with_original_language"],
    }

    if provider_filter?
      params["with_watch_providers"] = selected_provider_ids.join("|")
      params["watch_region"] = params["watch_region"].presence || "US"
      params["with_watch_monetization_types"] = "flatrate"
    end

    if media == "movie"
      params["with_runtime.gte"] = @query_params["with_runtime.gte"]
      params["with_runtime.lte"] = @query_params["with_runtime.lte"]
    end

    apply_kids_certification!(params, media)

    # A chosen language should override the default US-origin bias.
    if @query_params["with_original_language"].blank?
      params["with_origin_country"] = @query_params["with_origin_country"]
    end

    params.compact
  end

  # Prefer certification over genre alone for family-night filtering.
  # US: exclude G / TV-Y / TV-Y7 / TV-G by requiring PG / TV-PG or higher.
  def apply_kids_certification!(params, media)
    return unless exclude_kids?

    params["certification_country"] = "US"
    params["certification.gte"] = media == "tv" ? "TV-PG" : "PG"
  end

  def date_keys(media)
    media == "tv" ? %w[first_air_date.lte first_air_date.gte] : %w[primary_release_date.lte primary_release_date.gte]
  end

  def apply_year_range!(params, media, from, to)
    lte_key, gte_key = date_keys(media)
    today = Date.current.iso8601
    params[gte_key] = "#{from}-01-01" if from
    upper = to ? "#{to}-12-31" : today
    params[lte_key] = [upper, today].min
  end

  def year_ranges
    @year_ranges ||= begin
      raw = @query_params["ww_year_ranges"].to_s
      if raw.present?
        raw.split(",").filter_map do |pair|
          from, to = pair.split("-").map(&:to_i)
          [from, to] if from.positive? && to.positive?
        end
      else
        from = @query_params["primary_release_date.gte"].to_s.slice(0, 4).to_i
        to = @query_params["primary_release_date.lte"].to_s.slice(0, 4).to_i
        if from.positive? || to.positive?
          [[from.positive? ? from : 1900, to.positive? ? to : Date.current.year]]
        else
          []
        end
      end
    end
  end

  def normalize(item, media)
    if media == "tv"
      item.merge(
        "title" => item["name"].presence || item["title"],
        "release_date" => item["first_air_date"].presence || item["release_date"],
        "media_type" => "tv"
      )
    else
      item.merge("media_type" => "movie")
    end
  end

  def deck_key(movie)
    MediaKey.for(movie)
  end

  # Different page per pool, stable within a round, varies per game and round.
  def page_for(pool, max_page)
    @pages ||= {}
    @pages[pool] ||= 1 + @rng.rand(max_page)
  end

  # Deal one card from each pool in turn (up to its budget) so the deck feels
  # like a mix rather than blocks of similar titles.
  def interleave(plan)
    deck = []
    queues = plan.map { |movies, budget| { movies: movies.dup, budget: budget } }

    while deck.size < DECK_SIZE && queues.any? { |q| q[:budget].positive? && q[:movies].any? }
      queues.each do |q|
        break if deck.size >= DECK_SIZE
        next if q[:budget] <= 0 || q[:movies].empty?

        movie = q[:movies].shift
        next unless accept_for_deck?(deck, movie)

        deck << movie
        q[:budget] -= 1
      end
    end
    deck
  end

  def fill(deck, pools)
    pools.each do |movies|
      movies.each do |movie|
        break if deck.size >= DECK_SIZE
        next unless accept_for_deck?(deck, movie)

        deck << movie
      end
    end
  end

  def accept_for_deck?(deck, movie)
    return false if deck.any? { |m| deck_key(m) == deck_key(movie) }

    available_on_providers?(movie)
  end

  def provider_filter?
    selected_provider_ids.any?
  end

  def selected_provider_ids
    @selected_provider_ids ||= begin
      raw = @query_params["with_watch_providers"].to_s.split(/[|,]/).map(&:presence).compact
      raw.map { |id| PROVIDER_ID_ALIASES[id] || id }.uniq
    end
  end

  # TMDB discover provider filters are approximate; verify subscription
  # availability for the game region before dealing a title.
  def available_on_providers?(movie)
    return true unless provider_filter?

    key = deck_key(movie)
    @provider_availability ||= {}
    return @provider_availability[key] if @provider_availability.key?(key)

    region = @query_params["watch_region"].presence || "US"
    regions = TmdbClient.watch_providers(movie["id"], media: movie["media_type"] || "movie")
    streaming = (regions.dig(region, "flatrate") || []).map { |p| p["provider_id"].to_s }
    @provider_availability[key] = (streaming & selected_provider_ids).any?
  end

  def suitable?(movie)
    return false if movie["poster_path"].blank? || movie["adult"]
    return false if @excluded_keys.include?(deck_key(movie))
    return false if movie["release_date"].blank? || movie["release_date"] > Date.current.iso8601

    # Documentaries rate high on TMDB but are rarely movie-night picks;
    # only include them when explicitly requested.
    if movie["genre_ids"].to_a.include?(DOCUMENTARY_GENRE) &&
       !@query_params["with_genres"].to_s.split("|").include?(DOCUMENTARY_GENRE.to_s)
      return false
    end

    excluded_genres = @query_params["without_genres"].to_s.split("|").map(&:to_i)
    return false if excluded_genres.any? && (movie["genre_ids"].to_a & excluded_genres).any?

    # Supplement certification discover filters for recommendations / legacy.
    if exclude_kids?
      kids_genres = [FAMILY_GENRE, KIDS_GENRE]
      return false if (movie["genre_ids"].to_a & kids_genres).any?
    end

    matches_filters?(movie)
  end

  # Optional game filters also apply to recommendation candidates so custom
  # games stay on theme.
  def matches_filters?(movie)
    genres = @query_params["with_genres"].to_s.split("|").map(&:to_i)
    return false if genres.any? && (movie["genre_ids"].to_a & genres).empty?

    min_rating = @query_params["vote_average.gte"].to_f
    return false if movie["vote_average"].to_f < min_rating

    year = movie["release_date"].to_s.slice(0, 4).to_i
    ranges = year_ranges
    if ranges.any? && year.positive?
      return false unless ranges.any? { |from, to| year >= from && year <= to }
    end

    true
  end

  # Anything the players have liked or swiped before, plus anything dealt in
  # their recent games (covers abandoned rounds), never comes back.
  def excluded_media_keys
    user_ids = @game.players.map(&:user_id).uniq
    swiped = Player.where(user_id: user_ids)
                   .pluck(:liked_movie_ids, :seen_movie_ids)
                   .flatten
                   .compact
    recently_dealt = Game.where(id: Player.where(user_id: user_ids).select(:game_id))
                         .order(created_at: :desc)
                         .limit(RECENT_DEALT_GAMES)
                         .pluck(:dealt_movie_ids)
                         .flatten

    MediaKey.normalize_list(@game.dealt_movie_ids.to_a + swiped + recently_dealt).to_set
  end
end
