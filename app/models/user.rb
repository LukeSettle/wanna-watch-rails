class User < ApplicationRecord
  has_many :players
  has_many :games, through: :players
  has_many :other_players, through: :games, source: :players, class_name: 'Player', foreign_key: 'user_id'

  def friends
    games.map(&:players).flatten.map(&:user).uniq
  end
end
