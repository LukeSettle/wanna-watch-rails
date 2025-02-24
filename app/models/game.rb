class Game < ApplicationRecord
  belongs_to :user
  has_many :players

  accepts_nested_attributes_for :players, allow_destroy: true

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

  def player_finished(user, liked_movie_ids)
    players.find_by(user: user).update(finished_at: DateTime.current, liked_movie_ids: liked_movie_ids)
  end
end
