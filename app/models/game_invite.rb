class GameInvite < ApplicationRecord
  STATUSES = %w[pending accepted declined cancelled].freeze

  belongs_to :game
  belongs_to :inviter, class_name: "User"
  belongs_to :invitee, class_name: "User"

  validates :status, inclusion: { in: STATUSES }
  validate :invitee_is_not_inviter

  scope :pending, -> { where(status: "pending") }

  def pending?
    status == "pending"
  end

  def accept!
    raise ActiveRecord::RecordInvalid.new(self) unless pending?

    transaction do
      game.players.create!(user: invitee) unless game.players.exists?(user_id: invitee_id)
      update!(status: "accepted")
    end

    broadcast_to_users("game_invite_updated")
    game.broadcast_game_index_updated
    self
  end

  def decline!
    raise ActiveRecord::RecordInvalid.new(self) unless pending?

    update!(status: "declined")
    broadcast_to_users("game_invite_updated")
    self
  end

  def cancel!
    return self unless pending?

    update!(status: "cancelled")
    broadcast_to_users("game_invite_updated")
    self
  end

  def broadcast_created
    broadcast_to_users("game_invite")
    Notifier.game_invite(self)
  end

  def as_json(options = {})
    {
      id: id,
      status: status,
      game_id: game_id,
      entry_code: game.entry_code,
      created_at: created_at,
      inviter: user_json(inviter),
      invitee: user_json(invitee),
      game: game.as_json(include: { players: { include: :user } })
    }
  end

  private

  def invitee_is_not_inviter
    errors.add(:invitee, "can't invite yourself") if inviter_id.present? && inviter_id == invitee_id
  end

  def user_json(user)
    { id: user.id, username: user.username }
  end

  def broadcast_to_users(type)
    [inviter_id, invitee_id].uniq.each do |user_id|
      ActionCable.server.broadcast(
        "user_games_#{user_id}",
        { type: type, invite: as_json }
      )
    end
  end
end
