# What a group of players likes, learned from their ratings across all games.
#
# Liked titles become recommendation seeds (shared likes first, then each
# player's favorites in turn so nobody's taste is ignored). Genre affinity
# scores how well a title fits everyone: a genre one player dislikes drags
# the group score down even if the others love it.
class TasteProfile
  RECENT_RATINGS = 300
  SEEDS_PER_PLAYER = 30
  SMOOTHING = 3.0

  WEIGHTS = {
    watched_like: 2.0,
    like: 1.0,
    watched_dislike: -2.0,
    nope: -0.25,
  }.freeze

  def initialize(user_ids)
    @user_ids = user_ids.uniq
  end

  def empty?
    ratings_by_user.values.all?(&:empty?)
  end

  def rated_keys
    ratings_by_user.values.flatten.map(&:media_key).to_set
  end

  # Liked keys ordered by how many players share them, then fairly
  # interleaved across players (watched favorites first, then most recent).
  def seed_keys
    @seed_keys ||= begin
      per_user = @user_ids.map { |id| liked_keys_for(id) }
      counts = per_user.flatten.tally
      shared = counts.select { |_, count| count > 1 }.sort_by { |key, count| [-count, key] }.map(&:first)
      shared + (round_robin(per_user) - shared)
    end
  end

  def seed_weight(key)
    @seed_weights ||= ratings_by_user.values.flatten.select(&:liked).each_with_object(Hash.new(0)) do |rating, weights|
      weights[rating.media_key] += rating.watched ? 1.5 : 1.0
    end
    @seed_weights[key]
  end

  # Roughly -1 (the group dislikes these genres) to 1 (everyone loves them).
  def group_score(genre_ids)
    genre_ids = genre_ids.to_a.map(&:to_i)
    return 0.0 if genre_ids.empty? || @user_ids.empty?

    scores = @user_ids.map do |user_id|
      affinity = genre_affinity(user_id)
      genre_ids.sum { |genre| affinity[genre] } / genre_ids.size
    end
    mean = scores.sum / scores.size
    worst = scores.min
    worst.negative? ? (mean + worst) / 2 : mean
  end

  # Genres the whole group leans toward, best first.
  def top_genres(limit = 3)
    totals = Hash.new(0.0)
    @user_ids.each { |id| genre_affinity(id).each { |genre, score| totals[genre] += score } }
    totals.select { |_, score| score.positive? }.sort_by { |genre, score| [-score, genre] }.first(limit).map(&:first)
  end

  private

  def ratings_by_user
    @ratings_by_user ||= @user_ids.index_with do |user_id|
      MovieRating.where(user_id: user_id).order(updated_at: :desc).limit(RECENT_RATINGS).to_a
    end
  end

  def liked_keys_for(user_id)
    ratings_by_user[user_id].select(&:liked)
                            .sort_by { |r| [r.watched ? 0 : 1, -r.updated_at.to_f] }
                            .first(SEEDS_PER_PLAYER)
                            .map(&:media_key)
  end

  def round_robin(lists)
    longest = lists.map(&:size).max || 0
    (0...longest).flat_map { |i| lists.filter_map { |list| list[i] } }.uniq
  end

  def genre_affinity(user_id)
    @genre_affinity ||= {}
    @genre_affinity[user_id] ||= begin
      sums = Hash.new(0.0)
      magnitudes = Hash.new(0.0)
      ratings_by_user[user_id].each do |rating|
        weight = WEIGHTS[weight_kind(rating)]
        rating.genre_ids.to_a.each do |genre|
          sums[genre] += weight
          magnitudes[genre] += weight.abs
        end
      end
      affinity = sums.to_h { |genre, sum| [genre, sum / (magnitudes[genre] + SMOOTHING)] }
      affinity.default = 0.0
      affinity
    end
  end

  def weight_kind(rating)
    if rating.watched
      rating.liked ? :watched_like : :watched_dislike
    else
      rating.liked ? :like : :nope
    end
  end
end
