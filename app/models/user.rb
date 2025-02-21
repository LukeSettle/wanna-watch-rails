class User < ApplicationRecord
  has_many :players
  has_many :player_games, through: :players, source: :game
  has_many :owned_games, class_name: 'Game', foreign_key: 'user_id'

  def games
    (owned_games + player_games).uniq
  end

  def friends
    games.map(&:players).flatten.map(&:user).uniq
  end
end
