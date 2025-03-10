class UserGamesChannel < ApplicationCable::Channel
  def subscribed
    stream_from "user_games_#{current_user.id}"
  end

  def unsubscribed
    # Any cleanup needed when channel is unsubscribed
  end
end