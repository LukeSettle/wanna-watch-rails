class GamesController < ApiController
  def index
    user = User.find(params[:user_id])
    games = user.games.where(finished_at: nil)

    render json: games, include: { players: { include: :user } }, status: :ok
  end

  def previous
    user = User.find(params[:user_id])
    games = user.games.where.not(finished_at: nil).order(finished_at: :desc).limit(50)

    render json: games, include: { players: { include: :user } }, status: :ok
  end

  def upsert
    game = Game.find_or_initialize_by(entry_code: game_params[:entry_code])

    user = User.find(game_params[:user_id])
    game.players.new(user: user) unless game.players.find_by(user: user)

    if update_game_and_user(game, user)
      game.broadcast_game_index_updated
      render json: game, include: { players: { include: :user } }, status: :ok
    else
      render json: game.errors, status: :unprocessable_entity
    end
  end

  def find_by_entry_code
    game = Game.find_by entry_code: params[:entry_code]

    if game
      render json: game, include: { players: { include: :user } }, status: :ok
    else
      render json: { error: 'Game not found' }, status: :not_found
    end
  end

  def finish
    game = Game.find(params[:id])

    if game.update(finished_at: Time.now)
      game.broadcast_game_index_updated
      render json: { message: 'Game finished successfully' }, status: :ok
    else
      render json: { error: 'Failed to finish game' }, status: :unprocessable_entity
    end
  end

  def keep_playing
    game = Game.find(params[:game_id])
    user = User.find(params[:user_id])

    game.update(finished_at: nil, load_more_count: game.load_more_count + 1)
    game.players.update(finished_at: nil)

    broadcast_to_game(game, "#{user.username} continued the game")
    game.broadcast_game_index_updated

    render_game(game)
  end

  def deck
    game = Game.find(params[:id])

    if game.continuous?
      player = game.players.find_by(user_id: params[:user_id])
      return render json: { error: "Join the game first" }, status: :unprocessable_entity unless player

      render json: { movies: endless_deck_for(game, player) }, status: :ok
    else
      game.with_lock do
        if game.deck_round != game.load_more_count
          deck = DeckBuilder.new(game).build
          game.update!(
            deck: deck,
            deck_round: game.load_more_count,
            dealt_movie_ids: (game.dealt_movie_ids.to_a + deck.map { |m| MediaKey.for(m) }).uniq
          )
        end
      end

      render json: { movies: game.deck }, status: :ok
    end
  end

  # Endless mode: record each swipe as it happens, so players can swipe on
  # their own time and everyone gets alerted the moment a movie becomes a
  # match (liked by every player).
  def swipe
    game = Game.find(params[:id])
    player = game.players.find_by(user_id: params[:user_id])
    return render json: { error: "Join the game first" }, status: :unprocessable_entity unless player

    key = swipe_media_key
    return render json: { error: "Invalid title" }, status: :unprocessable_entity unless key

    liked = ActiveModel::Type::Boolean.new.cast(params[:liked])

    player.update!(
      seen_movie_ids: (player.seen_movie_ids.to_a + [key]).uniq,
      liked_movie_ids: liked ? (player.liked_movie_ids.to_a + [key]).uniq : player.liked_movie_ids
    )

    matched = liked && game.players.count > 1 &&
              game.players.reload.all? { |p| p.liked_movie_ids.to_a.include?(key) }

    if matched
      # First-match mode: the first movie everyone likes ends the game.
      if game.first_match?
        game.finish
        game.broadcast_game_index_updated
      end

      media_type, movie_id = MediaKey.parse(key)
      ActionCable.server.broadcast(
        "game_#{game.id}",
        {
          type: 'match',
          movie_id: movie_id,
          media_type: media_type,
          media_key: key,
          game: game.reload.to_json(include: { players: { include: :user } })
        }
      )
      Notifier.match_alert(game, movie_id)
    end

    render json: { matched: matched, media_key: key }, status: :ok
  end

  # One-level undo for continuous modes: remove the title from seen/liked.
  def undo_swipe
    game = Game.find(params[:id])
    player = game.players.find_by(user_id: params[:user_id])
    return render json: { error: "Join the game first" }, status: :unprocessable_entity unless player
    return render json: { error: "Game already finished" }, status: :unprocessable_entity if game.finished_at.present?

    key = swipe_media_key
    return render json: { error: "Invalid title" }, status: :unprocessable_entity unless key

    player.update!(
      seen_movie_ids: player.seen_movie_ids.to_a - [key],
      liked_movie_ids: player.liked_movie_ids.to_a - [key]
    )

    render json: { media_key: key }, status: :ok
  end

  def join
    game = Game.find(params[:id])
    user = User.find(params[:user_id])

    game.players.create(user: user) unless game.players.exists?(user_id: user.id)
    broadcast_to_game(game, "#{user.username} joined")

    render_game(game)
  end

  def leave
    game = Game.find(params[:id])
    user = User.find(params[:user_id])
    player = game.players.find_by(user: user)

    unless player || game.user_id == user.id
      return render json: { error: "Not in this game" }, status: :unprocessable_entity
    end

    notify_ids = (game.players.map(&:user_id) + [user.id]).uniq
    player&.destroy!

    remaining = game.players.reload
    if remaining.empty?
      game.destroy!
    else
      game.update!(user_id: remaining.first.user_id) if game.user_id == user.id
      broadcast_to_game(game, "#{user.username} left") if player
    end

    notify_ids.each do |user_id|
      ActionCable.server.broadcast(
        "user_games_#{user_id}",
        { type: "system", message: "game_index_updated" }
      )
    end

    render json: { message: "Left game" }, status: :ok
  end

  def ready
    game = Game.find(params[:id])
    user = User.find(params[:user_id])

    game.player_ready(user)
    game.start if game.reload.all_players_ready? && game.started_at.nil?
    broadcast_to_game(game, "#{user.username} is ready")

    render_game(game)
  end

  def finish_matching
    game = Game.find(params[:id])
    user = User.find(params[:user_id])

    game.player_finished(user, params[:liked_movie_ids] || [], params[:seen_movie_ids] || [])
    just_finished = false
    if game.reload.all_players_finished? && game.finished_at.nil?
      game.finish
      just_finished = true
    end
    broadcast_to_game(game, "#{user.username} is finished")

    if just_finished
      match_id = shared_liked_media_keys(game).first
      Notifier.match_alert(game, match_id) if match_id
    end

    render_game(game)
  end

  private

  def swipe_media_key
    MediaKey.normalize(
      params[:media_key].presence || params[:movie_id],
      params[:media_type]
    )
  end

  def shared_liked_media_keys(game)
    lists = game.players.map { |p| p.liked_movie_ids.to_a }
    return [] if lists.size < 2

    lists.reduce(:&)
  end

  # One growing shared list per endless game. Each player is served whatever
  # they haven't seen yet; when anyone runs low the list is extended with a
  # fresh curated batch. Fully-seen movies are pruned (their ids stay in
  # dealt_movie_ids) so the stored deck stays small.
  def endless_deck_for(game, player)
    movies = []

    game.with_lock do
      seen = player.reload.seen_movie_ids.to_a.to_set
      unseen = game.deck.to_a.reject { |m| seen.include?(MediaKey.for(m)) }

      if unseen.size < 10
        batch = DeckBuilder.new(game).build
        players = game.players.reload
        kept = game.deck.to_a.select do |m|
          key = MediaKey.for(m)
          players.any? { |p| !p.seen_movie_ids.to_a.include?(key) }
        end
        game.update!(
          deck: kept + batch,
          load_more_count: game.load_more_count + 1,
          dealt_movie_ids: (game.dealt_movie_ids.to_a + batch.map { |m| MediaKey.for(m) }).uniq
        )
        unseen = game.deck.to_a.reject { |m| seen.include?(MediaKey.for(m)) }
      end

      movies = unseen.first(20)
    end

    movies
  end

  def broadcast_to_game(game, message)
    ActionCable.server.broadcast(
      "game_#{game.id}",
      {
        type: 'system',
        message: message,
        game: game.reload.to_json(include: { players: { include: :user } })
      }
    )
  end

  def render_game(game)
    render json: game, include: { players: { include: :user } }, status: :ok
  end

  def game_params
    params.require(:game).permit(:entry_code, :query, :user_id, :mode, players_attributes: [:id, :user_id, :game_id, :_destroy])
  end

  def update_game_and_user(game, user)
    ActiveRecord::Base.transaction do
      game.assign_attributes(game_params)

      game.save!
      if params[:providers]
        providers = Array(params[:providers]).map { |id| DeckBuilder::PROVIDER_ID_ALIASES[id.to_s] || id.to_s }.uniq
        user.update!(providers: providers)
      end

      true
    rescue ActiveRecord::RecordInvalid => e
      false
    end
  end
end
