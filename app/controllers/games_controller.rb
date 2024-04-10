class GamesController < ApplicationController
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

  def keep_playing
    game = Game.find(params[:game_id])
    user = User.find(game_params[:user_id])

    game.update(finished_at: nil)
    game.players.update(finished_at: nil)

    ActionCable.server.broadcast(
      "game_#{game.id}",
      {
        type: 'system',
        message: "#{user.username} continued the game",
        game: game.reload.to_json(include: { players: { include: :user } })
      }
    )
  end

  private

  def game_params
    params.require(:game).permit(:entry_code, :query, :user_id)
  end

  def update_game_and_user(game, user)
    ActiveRecord::Base.transaction do
      game.update! game_params
      user.update!(providers: params[:providers])
    end
  end
end
