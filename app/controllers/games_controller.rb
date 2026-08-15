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
            dealt_movie_ids: (game.dealt_movie_ids.to_a + deck.map { |m| m["id"] }).uniq
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

    movie_id = params[:movie_id].to_i
    liked = ActiveModel::Type::Boolean.new.cast(params[:liked])

    player.update!(
      seen_movie_ids: (player.seen_movie_ids.to_a + [movie_id]).uniq,
      liked_movie_ids: liked ? (player.liked_movie_ids.to_a + [movie_id]).uniq : player.liked_movie_ids
    )

    matched = liked && game.players.count > 1 &&
              game.players.reload.all? { |p| p.liked_movie_ids.to_a.include?(movie_id) }

    if matched
      # First-match mode: the first movie everyone likes ends the game.
      if game.first_match?
        game.finish
        game.broadcast_game_index_updated
      end

      ActionCable.server.broadcast(
        "game_#{game.id}",
        {
          type: 'match',
          movie_id: movie_id,
          game: game.reload.to_json(include: { players: { include: :user } })
        }
      )
    end

    render json: { matched: matched }, status: :ok
  end

  def join
    game = Game.find(params[:id])
    user = User.find(params[:user_id])

    game.players.create(user: user) unless game.players.exists?(user_id: user.id)
    broadcast_to_game(game, "#{user.username} joined")

    render_game(game)
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
    game.finish if game.reload.all_players_finished?
    broadcast_to_game(game, "#{user.username} is finished")

    render_game(game)
  end

  private

  # One growing shared list per endless game. Each player is served whatever
  # they haven't seen yet; when anyone runs low the list is extended with a
  # fresh curated batch. Fully-seen movies are pruned (their ids stay in
  # dealt_movie_ids) so the stored deck stays small.
  def endless_deck_for(game, player)
    movies = []

    game.with_lock do
      seen = player.reload.seen_movie_ids.to_a
      unseen = game.deck.to_a.reject { |m| seen.include?(m["id"]) }

      if unseen.size < 10
        batch = DeckBuilder.new(game).build
        players = game.players.reload
        kept = game.deck.to_a.select do |m|
          players.any? { |p| !p.seen_movie_ids.to_a.include?(m["id"]) }
        end
        game.update!(
          deck: kept + batch,
          load_more_count: game.load_more_count + 1,
          dealt_movie_ids: (game.dealt_movie_ids.to_a + batch.map { |m| m["id"] }).uniq
        )
        unseen = game.deck.to_a.reject { |m| seen.include?(m["id"]) }
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
      user.update!(providers: params[:providers]) if params[:providers]

      true
    rescue ActiveRecord::RecordInvalid => e
      false
    end
  end
end
