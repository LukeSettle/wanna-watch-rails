# app/channels/game_channel.rb
class GameChannel < ApplicationCable::Channel
  def subscribed
    stream_from game_stream
    binding.pry
    @game = find_or_create_game
    @game.players << current_user
    ActionCable.server.broadcast(
      game_stream,
      {
        type: 'system',
        message: "#{current_user.display_name} joined",
        game: @game.state
      }
    )
  end

  def unsubscribed
    @game.remove_player(current_user)
    ActionCable.server.broadcast(
      game_stream,
      {
        type: 'system',
        message: "#{current_user.display_name} left",
        game: @game.state
      }
    )
  end

  def receive(data)
    case data['action']
    when 'ready'
      @game.player_ready(current_user)
      ActionCable.server.broadcast(
        game_stream,
        {
          type: 'system',
          message: "#{current_user.display_name} is ready",
          game: @game.state
        }
      )

      start_game if @game.all_players_ready?
    end
  end

  private

  def game_stream
    "game_#{params[:game_id]}"
  end

  def find_or_create_game
    Game.find_or_create_by(id: params[:game_id])
  end

  def start_game
    @game.start
    ActionCable.server.broadcast(
      game_stream,
      {
        type: 'system',
        message: 'Game starting!',
        game: @game.state
      }
    )
  end
end
