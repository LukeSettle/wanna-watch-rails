class GamesController < ApiController
  def index
    user = User.find(params[:user_id])
    games = user.games.where(finished_at: nil)

    render json: games, include: { players: { include: :user } }, status: :ok
  end

  def upsert
    game = Game.find_or_initialize_by(entry_code: game_params[:entry_code])

    user = User.find(game_params[:user_id])
    game.players.new(user: user)

    if update_game_and_user(game, user)
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

    render json: {}, status: 200
  end

  private

  def game_params
    params.require(:game).permit(:entry_code, :query, :user_id, players_attributes: [:id, :user_id, :_destroy])
  end

  def update_game_and_user(game, user)
    ActiveRecord::Base.transaction do
      game.assign_attributes(game_params)
      game.players.each { |player| player.game = game }

      game.save!
      user.update!(providers: params[:providers]) if params[:providers]
    end
  end
end
