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

    game.update(game_params.merge(finished_at: nil, load_more_count: game.load_more_count + 1))
    game.players.update(finished_at: nil)

    ActionCable.server.broadcast(
      "game_#{game.id}",
      {
        type: 'system',
        message: "#{user.username} continued the game",
        game: game.reload.to_json(include: { players: { include: :user } })
      }
    )

    game.broadcast_game_index_updated

    render json: {}, status: 200
  end

  def deck
    game = Game.find(params[:id])

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

    game.player_finished(user, params[:liked_movie_ids] || [])
    game.finish if game.reload.all_players_finished?
    broadcast_to_game(game, "#{user.username} is finished")

    render_game(game)
  end

  private

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
    params.require(:game).permit(:entry_code, :query, :user_id, players_attributes: [:id, :user_id, :game_id, :_destroy])
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
