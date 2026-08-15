require "test_helper"

class UserTest < ActiveSupport::TestCase
  test "friends excludes self and lists co-players" do
    owner = users(:one)
    friend = users(:two)
    game = games(:one)
    game.update!(user: owner, finished_at: nil)
    players(:one).update!(game: game, user: owner)
    Player.create!(game: game, user: friend)

    assert_includes owner.friends.map(&:id), friend.id
    assert_not_includes owner.friends.map(&:id), owner.id
  end

  test "normalizes US phone numbers to E.164" do
    assert_equal "+15551234567", User.normalize_phone("(555) 123-4567")
    assert_equal "+15551234567", User.normalize_phone("1-555-123-4567")
    assert_equal "+447911123456", User.normalize_phone("+44 7911 123456")
    assert_nil User.normalize_phone("123")
    assert_nil User.normalize_phone("")
  end

  test "stores normalized phone on save" do
    user = users(:one)
    user.update!(phone: "5559876543")
    assert_equal "+15559876543", user.reload.phone
  end

  test "notification prefs default on and merge updates" do
    user = users(:one)
    assert user.notification_category_enabled?("game_invite")
    assert user.wants_email_notifications? == false # no email

    user.update!(email: "one@example.com", notification_preferences: { "game_invite" => false })
    assert_not user.notification_category_enabled?("game_invite")
    assert user.notification_category_enabled?("match_alert")
    assert user.wants_email_notifications?
  end
end
