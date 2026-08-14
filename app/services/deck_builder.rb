# Builds a curated deck of movies for one round of a game.
#
# Sources, blended by how much taste history the players have:
#   1. TMDB recommendations seeded by the players' previously liked movies.
#      Candidates recommended by several seeds (or seeds shared by several
#      players) score higher.
#   2. Popular movies from TMDB discover, using the game's optional filters.
#
# With no history the deck is all popular movies; as players like more movies
# the deck shifts toward recommendations. Movies already dealt in this game or
# already liked by any player are excluded, so every round is fresh.
class DeckBuilder
  DECK_SIZE = 20
  MAX_SEEDS = 8
  RECENT_GAMES_PER_PLAYER = 10
  MIN_VOTE_COUNT = 50

  def initialize(game)
    @game = game
    @query_params = parse_query_params
    @excluded_ids = excluded_movie_ids
  end

  def build
    recommendations = recommendation_candidates
    personalized_count = [recommendations.size, (DECK_SIZE * 0.7).round].min
    popular = popular_candidates(recommendations.first(personalized_count))

    interleave(recommendations.first(personalized_count), popular).first(DECK_SIZE)
  end

  private

  def parse_query_params
    JSON.parse(@game.query.to_s)["params"] || {}
  rescue JSON::ParserError, TypeError
    {}
  end

  # Every movie the players liked before, most-shared first, rotated per round
  # so "keep playing" seeds from different favorites.
  def seed_movie_ids
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

  def recommendation_candidates
    scores = Hash.new(0)
    movies = {}

    seed_movie_ids.each do |seed_id|
      TmdbClient.recommendations(seed_id).each do |movie|
        next unless suitable?(movie)

        scores[movie["id"]] += 1
        movies[movie["id"]] = movie
      end
    end

    scores.sort_by { |_, score| -score }.map { |movie_id, _| movies[movie_id] }
  end

  def popular_candidates(already_picked)
    picked_ids = already_picked.map { |movie| movie["id"] }
    first_page = (@query_params["page"].to_i + @game.load_more_count) % 5 + 1

    candidates = []
    [first_page, first_page + 5].each do |page|
      break if candidates.size >= DECK_SIZE

      candidates += TmdbClient.discover(@query_params.merge("page" => page, "sort_by" => "popularity.desc"))
                              .select { |movie| suitable?(movie) && !picked_ids.include?(movie["id"]) }
    end
    candidates.uniq { |movie| movie["id"] }
  end

  # Recommendations feel personal; popular picks keep variety. Deal 2:1.
  def interleave(recommendations, popular)
    deck = []
    recommendations = recommendations.dup
    popular = popular.dup

    while deck.size < DECK_SIZE && (recommendations.any? || popular.any?)
      2.times { deck << recommendations.shift if recommendations.any? }
      deck << popular.shift if popular.any?
    end
    deck.uniq { |movie| movie["id"] }
  end

  def suitable?(movie)
    return false if movie["poster_path"].blank? || movie["adult"]
    return false if @excluded_ids.include?(movie["id"])
    return false if movie["vote_count"].to_i < MIN_VOTE_COUNT

    matches_filters?(movie)
  end

  # Optional game filters (genres / rating / years) also apply to
  # recommendation candidates so custom games stay on theme.
  def matches_filters?(movie)
    genres = @query_params["with_genres"].to_s.split("|").map(&:to_i)
    return false if genres.any? && (movie["genre_ids"].to_a & genres).empty?

    min_rating = @query_params["vote_average.gte"].to_f
    return false if movie["vote_average"].to_f < min_rating

    min_runtime = @query_params["with_runtime.gte"].to_i
    max_runtime = @query_params["with_runtime.lte"].to_i
    runtime = movie["runtime"].to_i
    return false if min_runtime.positive? && runtime.positive? && runtime < min_runtime
    return false if max_runtime.positive? && max_runtime < 400 && runtime.positive? && runtime > max_runtime

    year = movie["release_date"].to_s.slice(0, 4).to_i
    year_from = @query_params["primary_release_date.gte"].to_s.slice(0, 4).to_i
    year_to = @query_params["primary_release_date.lte"].to_s.slice(0, 4).to_i
    return false if year_from.positive? && year.positive? && year < year_from
    return false if year_to.positive? && year.positive? && year > year_to

    true
  end

  def excluded_movie_ids
    previously_liked = Player.where(user_id: @game.players.map(&:user_id)).pluck(:liked_movie_ids).flatten
    (@game.dealt_movie_ids.to_a + previously_liked).uniq
  end
end
