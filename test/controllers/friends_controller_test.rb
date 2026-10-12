require "test_helper"

class FriendsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @me = User.create!(username: "Me")
    @friend = User.create!(username: "Friend")
    game = Game.create!(user: @me, entry_code: "FRND01")
    game.players.create!(user: @me)
    game.players.create!(user: @friend)
  end

  test "index includes when you last played together" do
    get "/friends/index", params: { user_id: @me.id }

    assert_response :success
    friend_json = response.parsed_body.first
    assert_equal @friend.id, friend_json["id"]
    assert friend_json["last_played_at"].present?
  end

  test "remove hides the friend from the list" do
    post "/friends/remove", params: { user_id: @me.id, friend_id: @friend.id }
    assert_response :success

    get "/friends/index", params: { user_id: @me.id }
    assert_empty response.parsed_body
  end
end
