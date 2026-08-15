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
end
