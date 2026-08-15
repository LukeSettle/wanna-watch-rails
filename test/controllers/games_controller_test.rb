require "test_helper"

class GamesControllerTest < ActionDispatch::IntegrationTest
  setup do
    @owner = users(:one)
    @other = users(:two)
    @game = games(:one)
    @game.update!(entry_code: "LEAVE1", finished_at: nil)
    players(:one).update!(game: @game, user: @owner)
  end

  test "leave removes the current user from the game" do
    Player.create!(user: @other, game: @game)

    post leave_game_url(@game), params: { user_id: @owner.id }, as: :json

    assert_response :success
    assert_not Player.exists?(user: @owner, game: @game)
    assert Player.exists?(user: @other, game: @game)
    assert_equal @other.id, @game.reload.user_id
  end

  test "leave destroys the game when no players remain" do
    post leave_game_url(@game), params: { user_id: @owner.id }, as: :json

    assert_response :success
    assert_not Game.exists?(@game.id)
  end

  test "leave rejects users who are not in the game" do
    post leave_game_url(@game), params: { user_id: @other.id }, as: :json

    assert_response :unprocessable_entity
    assert Game.exists?(@game.id)
  end

  test "swipe stores media keys and undo removes them" do
    @game.update!(mode: "endless", finished_at: nil)
    player = players(:one)
    player.update!(game: @game, user: @owner, liked_movie_ids: [], seen_movie_ids: [])

    post swipe_game_url(@game), params: {
      user_id: @owner.id,
      movie_id: 550,
      media_type: "movie",
      liked: true
    }, as: :json

    assert_response :success
    player.reload
    assert_includes player.seen_movie_ids, "movie:550"
    assert_includes player.liked_movie_ids, "movie:550"

    post undo_swipe_game_url(@game), params: {
      user_id: @owner.id,
      movie_id: 550,
      media_type: "movie"
    }, as: :json

    assert_response :success
    player.reload
    assert_not_includes player.seen_movie_ids, "movie:550"
    assert_not_includes player.liked_movie_ids, "movie:550"
  end

  test "tv swipe uses tv media key so ids do not collide" do
    @game.update!(mode: "endless", finished_at: nil)
    player = players(:one)
    player.update!(game: @game, user: @owner, liked_movie_ids: ["movie:550"], seen_movie_ids: ["movie:550"])

    post swipe_game_url(@game), params: {
      user_id: @owner.id,
      movie_id: 550,
      media_type: "tv",
      liked: true
    }, as: :json

    assert_response :success
    player.reload
    assert_includes player.liked_movie_ids, "movie:550"
    assert_includes player.liked_movie_ids, "tv:550"
  end
end
