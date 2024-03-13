class GamesController < ApplicationController
  def upsert
    game = Game.find_or_initialize_by(entry_code: game_params[:entry_code])

    user = User.find(game_params[:user_id])
    game.players.new(user: user)

    if game.update game_params
      render json: game, include: [:players], status: :ok
    else
      render json: game.errors, status: :unprocessable_entity
    end
  end

  def find_by_entry_code
    game = Game.find_by entry_code: params[:entry_code]

    if game
      render json: game, status: :ok
    else
      render json: { error: 'Game not found' }, status: :not_found
    end
  end

  private

  def game_params
    params.require(:game).permit(:entry_code, :query, :user_id)
  end
end
