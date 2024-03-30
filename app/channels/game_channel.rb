# app/channels/game_channel.rb
class GameChannel < ApplicationCable::Channel
  def subscribed
    stream_from game_stream
    @game = find_game
    @game.players << Player.create(user: current_user)

    ActionCable.server.broadcast(
      game_stream,
      {
        type: 'system',
        message: "#{current_user.username} joined",
        game: @game.reload.to_json(include: { players: { include: :user } })
      }
    )
  end

  def unsubscribed
    @game.players.find_by(user: current_user).destroy unless @game.started_at.present?

    ActionCable.server.broadcast(
      game_stream,
      {
        type: 'system',
        message: "#{current_user.username} left",
        game: @game.reload.to_json(include: { players: { include: :user } })
      }
    )
  end

  def ready
    @game.player_ready(current_user)

    start_game if @game.reload.all_players_ready?

    ActionCable.server.broadcast(
      game_stream,
      {
        type: 'system',
        message: "#{current_user.username} is ready",
        game: @game.to_json(include: { players: { include: :user } })
      }
    )
  end

  def finish_matching(data)
    @game.player_finished(current_user, data['liked_movie_ids'])

    @game.finish if @game.reload.all_players_finished?

    ActionCable.server.broadcast(
      game_stream,
      {
        type: 'system',
        message: "#{current_user.username} is finished",
        game: @game.reload.to_json(include: { players: { include: :user } })
      }
    )
  end

  private

  def game_stream
    "game_#{params[:game_id]}"
  end

  def find_game
    Game.find(params[:game_id])
  end

  def start_game
    @game.start
    ActionCable.server.broadcast(
      game_stream,
      {
        type: 'system',
        message: 'Game starting!',
        game: @game.reload.to_json(include: { players: { include: :user } })
      }
    )
  end
end
