class User < ApplicationRecord
  include UserEntitlements

  has_secure_password validations: false

  DEFAULT_NOTIFICATION_PREFERENCES = {
    "email_enabled" => true,
    "sms_enabled" => true,
    "game_invite" => true,
    "game_nudge" => true,
    "match_alert" => true
  }.freeze

  PHONE_FORMAT = /\A\+[1-9]\d{7,14}\z/

  before_validation { self.email = email.to_s.strip.downcase.presence }
  before_validation :normalize_phone_number

  validates :email, uniqueness: true, format: { with: URI::MailTo::EMAIL_REGEXP }, allow_nil: true
  validates :phone, uniqueness: true, format: { with: PHONE_FORMAT }, allow_nil: true

  # Never leak credentials or contact info in game payloads and broadcasts.
  def as_json(options = {})
    super({
      except: [
        :email, :phone, :notification_preferences,
        :password_digest, :reset_token_digest, :reset_token_sent_at,
        :stripe_customer_id, :stripe_subscription_id
      ]
    }.merge(options))
  end

  has_many :players
  has_many :purchases, dependent: :destroy
  has_many :owned_games, class_name: "Game", foreign_key: "user_id"
  has_many :sent_invites, class_name: "GameInvite", foreign_key: "inviter_id", dependent: :destroy
  has_many :received_invites, class_name: "GameInvite", foreign_key: "invitee_id", dependent: :destroy

  has_many :games, ->(user) {
    unscope(where: :user_id).where(
      "games.user_id = :id OR games.id IN (SELECT game_id FROM players WHERE user_id = :id)",
      id: user.id
    ).distinct
  }, class_name: "Game"

  def friends
    games.includes(players: :user)
         .flat_map { |game| game.players.map(&:user) }
         .compact
         .uniq
         .reject { |user| user.id == id }
  end

  def notification_preferences_with_defaults
    DEFAULT_NOTIFICATION_PREFERENCES.merge((notification_preferences || {}).stringify_keys)
  end

  def notification_category_enabled?(category)
    ActiveModel::Type::Boolean.new.cast(notification_preferences_with_defaults[category.to_s])
  end

  def wants_email_notifications?
    email.present? && ActiveModel::Type::Boolean.new.cast(notification_preferences_with_defaults["email_enabled"])
  end

  def wants_sms_notifications?
    phone.present? && ActiveModel::Type::Boolean.new.cast(notification_preferences_with_defaults["sms_enabled"])
  end

  def assign_notification_preferences(prefs)
    return if prefs.blank?

    allowed = DEFAULT_NOTIFICATION_PREFERENCES.keys
    merged = notification_preferences_with_defaults
    prefs.to_h.stringify_keys.slice(*allowed).each do |key, value|
      merged[key] = ActiveModel::Type::Boolean.new.cast(value)
    end
    self.notification_preferences = merged
  end

  def self.normalize_phone(raw)
    return nil if raw.blank?

    stripped = raw.to_s.strip
    digits = stripped.gsub(/\D/, "")
    return nil if digits.blank?

    e164 =
      if digits.length == 10
        "+1#{digits}"
      elsif digits.length == 11 && digits.start_with?("1")
        "+#{digits}"
      else
        "+#{digits}"
      end

    e164.match?(PHONE_FORMAT) ? e164 : nil
  end

  private

  def normalize_phone_number
    self.phone = self.class.normalize_phone(phone)
  end
end
