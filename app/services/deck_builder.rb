# Builds a curated deck of movies for one round of a game.
#
# Sourcing strategy: instead of raw TMDB popularity (franchise blockbusters,
# unreleased hype titles, junk on deep pages), each deck mixes quality pools:
#
#   recs      - TMDB recommendations seeded by the players' liked movies
#   popular   - current popular titles, filtered to well-rated and widely voted
#   gems      - highly rated but less-known movies ("hidden gems")
#   acclaimed - widely loved catalog picks across eras
#
# With no like history the deck is popular + gems + acclaimed. As players like
# movies, recommendations take a growing share. Movies any player has already
# liked, swiped past, or been dealt in recent games are excluded, so decks
# never repeat.
class DeckBuilder
  DECK_SIZE = 20
  MAX_SEEDS = 6
  RECENT_GAMES_PER_PLAYER = 10
  RECENT_DEALT_GAMES = 15

  def initialize(game)
    @game = game
    @query_params = parse_query_params
    @excluded_ids = excluded_movie_ids
    @rng = Random.new(game.id * 31 + game.load_more_count)
  end

  def build
    recs = recommendation_candidates
    plan = [
      [recs, [recs.size, personalized_target].min],
      [popular_candidates, 6],
      [hidden_gem_candidates, 4],
      [acclaimed_candidates, 4],
    ]

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

  # More like-history means a bigger personalized share (max half the deck).
  def personalized_target
    [seed_movie_ids.size * 2, DECK_SIZE / 2].min
  end

  # Players' liked movies, most-shared first, rotated per round so
  # "keep playing" seeds from different favorites.
  def seed_movie_ids
    @seed_movie_ids ||= begin
      like_counts = Hash.new(0)
      @game.players.map(&:user_id).uniq.each do |user_id|
        recent_likes = Player.where(user_id: user_id)
                             .order(updated_at: :desc)
                             .limit(RECENT_GAMES_PER_PLAYER)
                             .pluck(:liked_movie_ids)
                             .flatten
        recent_likes.uniq.each { |movie_id| like_counts[movie_id] += 1 }
      end

      like_counts.sort_by { |movie_id, count| [-count, -movie_id] }
                 .map(&:first)
                 .rotate(@game.load_more_count * MAX_SEEDS)
                 .first(MAX_SEEDS)
    end
  end

  def recommendation_candidates
    scores = Hash.new(0)
    movies = {}

    seed_movie_ids.each do |seed_id|
      TmdbClient.recommendations(seed_id).each do |movie|
        next unless suitable?(movie)
        next if movie["vote_count"].to_i < 150 || movie["vote_average"].to_f < 6.2

        scores[movie["id"]] += 1
        movies[movie["id"]] = movie
      end
    end

    scores.sort_by { |_, score| -score }.map { |movie_id, _| movies[movie_id] }
  end

  def popular_candidates
    @popular_candidates ||= discover_pool(
      "sort_by" => "popularity.desc",
      "vote_count.gte" => 400,
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
    TmdbClient.discover(base_discover_params.merge(overrides))
              .select { |movie| suitable?(movie) }
  end

  def base_discover_params
    today = Date.current.iso8601
    params = {
      "include_adult" => false,
      "primary_release_date.lte" => [@query_params["primary_release_date.lte"], today].compact.min,
      "primary_release_date.gte" => @query_params["primary_release_date.gte"],
      "with_genres" => @query_params["with_genres"],
      "with_watch_providers" => @query_params["with_watch_providers"],
      "watch_region" => @query_params["watch_region"],
      "with_original_language" => @query_params["with_original_language"],
      "with_runtime.gte" => @query_params["with_runtime.gte"],
      "with_runtime.lte" => @query_params["with_runtime.lte"],
    }
    # A chosen language should override the default US-origin bias.
    if @query_params["with_original_language"].blank?
      params["with_origin_country"] = @query_params["with_origin_country"]
    end
    params.compact
  end

  # Different page per pool, stable within a round, varies per game and round.
  def page_for(pool, max_page)
    @pages ||= {}
    @pages[pool] ||= 1 + @rng.rand(max_page)
  end

  # Deal one card from each pool in turn (up to its budget) so the deck feels
  # like a mix rather than blocks of similar movies.
  def interleave(plan)
    deck = []
    queues = plan.map { |movies, budget| { movies: movies.dup, budget: budget } }

    while deck.size < DECK_SIZE && queues.any? { |q| q[:budget].positive? && q[:movies].any? }
      queues.each do |q|
        break if deck.size >= DECK_SIZE
        next if q[:budget] <= 0 || q[:movies].empty?

        movie = q[:movies].shift
        next if deck.any? { |m| m["id"] == movie["id"] }

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

        deck << movie unless deck.any? { |m| m["id"] == movie["id"] }
      end
    end
  end

  DOCUMENTARY_GENRE = 99

  def suitable?(movie)
    return false if movie["poster_path"].blank? || movie["adult"]
    return false if @excluded_ids.include?(movie["id"])
    return false if movie["release_date"].blank? || movie["release_date"] > Date.current.iso8601
    # Documentaries rate high on TMDB but are rarely movie-night picks;
    # only include them when explicitly requested.
    if movie["genre_ids"].to_a.include?(DOCUMENTARY_GENRE) &&
       !@query_params["with_genres"].to_s.split("|").include?(DOCUMENTARY_GENRE.to_s)
      return false
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
    year_from = @query_params["primary_release_date.gte"].to_s.slice(0, 4).to_i
    year_to = @query_params["primary_release_date.lte"].to_s.slice(0, 4).to_i
    return false if year_from.positive? && year.positive? && year < year_from
    return false if year_to.positive? && year.positive? && year > year_to

    true
  end

  # Anything the players have liked or swiped before, plus anything dealt in
  # their recent games (covers abandoned rounds), never comes back.
  def excluded_movie_ids
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

    (@game.dealt_movie_ids.to_a + swiped + recently_dealt).to_set
  end
end
