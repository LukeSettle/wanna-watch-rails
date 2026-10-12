require "test_helper"

class GameTest < ActiveSupport::TestCase
  setup do
    @game = games(:one)
    @game.update!(dealt_movie_ids: [], deck: [])
  end

  test "remember_movies! keeps swipe order and ignores duplicates" do
    @game.remember_movies!([
      { "id" => 1, "media_type" => "movie", "title" => "One", "genre_ids" => [18] },
      { "id" => 2, "media_type" => "movie", "title" => "Two", "genre_ids" => [35] },
    ])
    @game.remember_movies!([
      { "id" => 2, "media_type" => "movie", "title" => "Two again" },
      { "id" => 3, "media_type" => "tv", "title" => "Three" },
    ])

    list = @game.game_movies.order(:position)
    assert_equal ["movie:1", "movie:2", "tv:3"], list.map(&:media_key)
    assert_equal "One", list.first.payload["title"]
    assert_equal "Two", list.second.payload["title"]
    assert_equal ["movie:1", "movie:2", "tv:3"], @game.reload.dealt_movie_ids
  end

  test "asked_someone? is true after an invite or a joined friend" do
    assert_not @game.asked_someone?

    @game.update!(invite_sent_at: Time.current)
    assert @game.asked_someone?

    @game.update!(invite_sent_at: nil)
    GameInvite.create!(game: @game, inviter: users(:one), invitee: users(:two))
    assert @game.reload.asked_someone?
  end
end
