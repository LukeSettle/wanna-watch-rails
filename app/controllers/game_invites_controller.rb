class GameInvitesController < ApiController
  def index
    user = User.find(params[:user_id])
    invites = GameInvite.pending
                        .where("invitee_id = :id OR inviter_id = :id", id: user.id)
                        .includes(:game, :inviter, :invitee, game: { players: :user })
                        .order(created_at: :desc)

    render json: invites.map(&:as_json), status: :ok
  end

  def create
    inviter = User.find(params[:inviter_id])
    invitee = User.find(params[:invitee_id])
    game = Game.find(params[:game_id])

    return render json: { error: "Can't invite yourself" }, status: :unprocessable_entity if inviter.id == invitee.id
    return render json: { error: "Game already finished" }, status: :unprocessable_entity if game.finished_at.present?
    return render json: { error: "Only players can invite" }, status: :forbidden unless can_invite?(game, inviter)
    return render json: { error: "Already in this game" }, status: :unprocessable_entity if game.players.exists?(user_id: invitee.id)

    existing = GameInvite.pending.find_by(game: game, invitee: invitee)
    if existing
      return render json: existing.as_json, status: :ok
    end

    invite = GameInvite.create!(game: game, inviter: inviter, invitee: invitee)
    invite.broadcast_created

    render json: invite.as_json, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.record.errors.full_messages.to_sentence }, status: :unprocessable_entity
  end

  def accept
    invite = GameInvite.find(params[:id])
    user = User.find(params[:user_id])

    return render json: { error: "Not your invite" }, status: :forbidden unless invite.invitee_id == user.id
    return render json: { error: "Invite is no longer pending" }, status: :unprocessable_entity unless invite.pending?
    return render json: { error: "Game already finished" }, status: :unprocessable_entity if invite.game.finished_at.present?

    invite.accept!
    ActionCable.server.broadcast(
      "game_#{invite.game_id}",
      {
        type: "system",
        message: "#{invite.invitee.username} joined",
        game: invite.game.reload.to_json(include: { players: { include: :user } })
      }
    )

    render json: invite.as_json, status: :ok
  rescue ActiveRecord::RecordInvalid
    render json: { error: "Could not accept invite" }, status: :unprocessable_entity
  end

  def decline
    invite = GameInvite.find(params[:id])
    user = User.find(params[:user_id])

    return render json: { error: "Not your invite" }, status: :forbidden unless invite.invitee_id == user.id
    return render json: { error: "Invite is no longer pending" }, status: :unprocessable_entity unless invite.pending?

    invite.decline!
    render json: invite.as_json, status: :ok
  rescue ActiveRecord::RecordInvalid
    render json: { error: "Could not decline invite" }, status: :unprocessable_entity
  end

  private

  def can_invite?(game, user)
    game.user_id == user.id || game.players.exists?(user_id: user.id)
  end
end
