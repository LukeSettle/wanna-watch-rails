class User < ApplicationRecord
  has_secure_password validations: false

  before_validation { self.email = email.to_s.strip.downcase.presence }
  validates :email, uniqueness: true, format: { with: URI::MailTo::EMAIL_REGEXP }, allow_nil: true

  # Never leak credentials or emails in game payloads and broadcasts.
  def as_json(options = {})
    super({ except: [:email, :password_digest, :reset_token_digest, :reset_token_sent_at] }.merge(options))
  end

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
