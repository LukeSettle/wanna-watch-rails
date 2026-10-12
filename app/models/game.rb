class Game < ApplicationRecord
  belongs_to :user
  has_many :players
  has_many :game_invites, dependent: :destroy
  has_many :game_movies, -> { order(:position) }, dependent: :destroy


  def endless?
    mode == "endless"
  end

  def first_match?
    mode == "first_match"
  end

  # Modes that serve one growing shared list with per-swipe reporting.
  def continuous?
    endless? || first_match?
  end

  accepts_nested_attributes_for :players, allow_destroy: true

  # The deck is large and only needed via games#deck; keep it out of game
  # payloads and broadcasts.
  def as_json(options = {})
    super({ except: [:deck, :dealt_movie_ids] }.merge(options))
  end

  def all_players_ready?
    players.all? { |player| player.ready_at.present? }
  end

  def all_players_finished?
    players.all? { |player| player.finished_at.present? }
  end

  def broadcast_game_index_updated
    players.each do |player|
      ActionCable.server.broadcast(
        "user_games_#{player.user.id}",
        {
          type: 'system',
          message: 'game_index_updated'
        }
      )
    end
  end

  def start
    update(started_at: DateTime.current)
  end

  def finish
    update(finished_at: DateTime.current)
  end

  def player_ready(user)
    players.find_by(user: user).update(ready_at: DateTime.current)
  end

  def player_finished(user, liked_movie_ids, seen_movie_ids = [])
    player = players.find_by(user: user)
    liked = MediaKey.normalize_list(liked_movie_ids)
    seen = MediaKey.normalize_list(seen_movie_ids)
    player.update(
      finished_at: DateTime.current,
      liked_movie_ids: liked,
      seen_movie_ids: (player.seen_movie_ids.to_a + seen).uniq
    )
    (liked | seen).each { |key| record_swipe(user, key, liked: liked.include?(key)) }
  end

  def record_swipe(user, key, liked:)
    MovieRating.record_swipe(user, key, liked: liked, genre_ids: genre_ids_for(key))
  end

  def record_watched(user, key, liked:)
    MovieRating.record_watched(user, key, liked: liked, genre_ids: genre_ids_for(key))
  end

  def genre_ids_for(key)
    movie = game_movies.find_by(media_key: key)&.payload
    movie ||= deck.to_a.find { |entry| MediaKey.for(entry) == key }
    movie ? movie["genre_ids"].to_a.map(&:to_i) : []
  end

  # The host can start after asking someone, before that person has joined.
  def asked_someone?
    players.count >= 2 || invite_sent_at.present? || game_invites.where(status: %w[pending accepted]).exists?
  end

  # Append-only record of every title dealt into this game, in swipe order.
  # Later joiners are served from this list, so it is never pruned.
  def remember_movies!(movies)
    known = game_movies.unscope(:order).pluck(:media_key).to_set
    position = (game_movies.unscope(:order).maximum(:position) || -1) + 1
    added = []

    transaction do
      Array(movies).each do |movie|
        next unless movie.is_a?(Hash)

        key = MediaKey.for(movie)
        _media, movie_id = MediaKey.parse(key)
        next if movie_id <= 0 || known.include?(key)

        game_movies.create!(media_key: key, position: position, payload: movie)
        known << key
        added << key
        position += 1
      end

      update!(dealt_movie_ids: (dealt_movie_ids.to_a + added).uniq) if added.any?
    end

    added
  end

  # Games started before the movie list existed keep whatever is still on deck.
  def seed_movie_list_from_deck!
    return if game_movies.exists?

    remember_movies!(Array(deck))
  end

  def unseen_movie_count_for(player)
    unseen_movies_for(player).count
  end

  def movie_payloads_for(player, limit:)
    unseen_movies_for(player, limit: limit).map(&:payload)
  end

  def unseen_movies_for(player, limit: nil)
    seen = player.seen_movie_ids.to_a
    relation = game_movies.order(:position)
    relation = relation.where.not(media_key: seen) if seen.any?
    relation = relation.limit(limit) if limit
    relation
  end
end

