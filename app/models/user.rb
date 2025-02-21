class User < ApplicationRecord
  has_many :players
  has_many :owned_games, class_name: "Game", foreign_key: "user_id"

  has_many :games, ->(user) {
    unscope(where: :user_id).where(
      "games.user_id = :id OR games.id IN (SELECT game_id FROM players WHERE user_id = :id)",
      id: user.id
    ).distinct
  }, class_name: "Game"

  def friends
    games.includes(:players).map { |game| game.players.map(&:user) }.flatten.uniq
  end
end
