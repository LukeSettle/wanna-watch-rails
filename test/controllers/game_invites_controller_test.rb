require "test_helper"

class GameInvitesControllerTest < ActionDispatch::IntegrationTest
  setup do
    @inviter = users(:one)
    @invitee = users(:two)
    @game = games(:one)
    @game.update!(entry_code: "INVITE", finished_at: nil, user: @inviter)
    players(:one).update!(game: @game, user: @inviter)
  end

  test "create sends a pending invite" do
    assert_difference("GameInvite.count", 1) do
      post game_invites_url, params: {
        inviter_id: @inviter.id,
        invitee_id: @invitee.id,
        game_id: @game.id
      }, as: :json
    end

    assert_response :created
    body = JSON.parse(response.body)
    assert_equal "pending", body["status"]
    assert_equal @invitee.id, body["invitee"]["id"]
    assert_equal "INVITE", body["entry_code"]
  end

  test "index returns pending invites for a user" do
    invite = GameInvite.create!(game: @game, inviter: @inviter, invitee: @invitee)

    get game_invites_url(user_id: @invitee.id), as: :json

    assert_response :success
    body = JSON.parse(response.body)
    assert_equal 1, body.length
    assert_equal invite.id, body.first["id"]
  end

  test "accept joins the invitee to the game" do
    invite = GameInvite.create!(game: @game, inviter: @inviter, invitee: @invitee)

    post accept_game_invite_url(invite), params: { user_id: @invitee.id }, as: :json

    assert_response :success
    assert_equal "accepted", invite.reload.status
    assert Player.exists?(user: @invitee, game: @game)
  end

  test "decline marks the invite declined" do
    invite = GameInvite.create!(game: @game, inviter: @inviter, invitee: @invitee)

    post decline_game_invite_url(invite), params: { user_id: @invitee.id }, as: :json

    assert_response :success
    assert_equal "declined", invite.reload.status
    assert_not Player.exists?(user: @invitee, game: @game)
  end

  test "cannot invite yourself" do
    post game_invites_url, params: {
      inviter_id: @inviter.id,
      invitee_id: @inviter.id,
      game_id: @game.id
    }, as: :json

    assert_response :unprocessable_entity
  end
end
