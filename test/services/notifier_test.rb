require "test_helper"

class NotifierTest < ActiveSupport::TestCase
  setup do
    @user = users(:one)
    @user.update!(
      email: "alert@example.com",
      phone: "+15551234567",
      notification_preferences: User::DEFAULT_NOTIFICATION_PREFERENCES
    )
    @inviter = users(:two)
    @inviter.update!(username: "Sam")
    @game = games(:one)
    @game.update!(entry_code: "ABC123", finished_at: nil, user: @inviter)
    players(:one).update!(game: @game, user: @inviter)
  end

  test "game invite sends email when category enabled" do
    invite = GameInvite.create!(game: @game, inviter: @inviter, invitee: @user)

    assert_difference("ActionMailer::Base.deliveries.size", 1) do
      Notifier.game_invite(invite)
    end

    mail = ActionMailer::Base.deliveries.last
    assert_equal ["alert@example.com"], mail.to
    assert_match(/ABC123/, mail.body.encoded)
  end

  test "skips email when category disabled" do
    @user.update!(notification_preferences: { "game_invite" => false })
    invite = GameInvite.create!(game: @game, inviter: @inviter, invitee: @user)

    assert_no_difference("ActionMailer::Base.deliveries.size") do
      Notifier.game_invite(invite)
    end
  end

  test "sms no-ops without twilio credentials" do
    %w[TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM_NUMBER].each { |k| ENV.delete(k) }
    assert_equal false, TwilioSmsClient.send_sms(to: @user.phone, body: "hi")
  end

  test "match alert notifies players with email" do
    Player.create!(game: @game, user: @user)
    assert_difference("ActionMailer::Base.deliveries.size", 1) do
      Notifier.match_alert(@game, 42)
    end
  end
end
