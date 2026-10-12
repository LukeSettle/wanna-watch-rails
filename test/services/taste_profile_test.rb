require "test_helper"

class TasteProfileTest < ActiveSupport::TestCase
  setup do
    @one = users(:one)
    @two = users(:two)
  end

  test "shared likes seed first, then each player's likes in turn" do
    MovieRating.create!(user: @one, media_key: "movie:1", liked: true, updated_at: 3.days.ago)
    MovieRating.create!(user: @one, media_key: "movie:2", liked: true, updated_at: 1.day.ago)
    MovieRating.create!(user: @two, media_key: "movie:2", liked: true, updated_at: 2.days.ago)
    MovieRating.create!(user: @two, media_key: "movie:3", liked: true)
    MovieRating.create!(user: @two, media_key: "movie:4", liked: false)

    assert_equal %w[movie:2 movie:3 movie:1], TasteProfile.new([@one.id, @two.id]).seed_keys
  end

  test "a genre one player dislikes lowers the group score" do
    MovieRating.create!(user: @one, media_key: "movie:1", liked: true, genre_ids: [27])
    MovieRating.create!(user: @one, media_key: "movie:2", liked: true, genre_ids: [35])
    MovieRating.create!(user: @two, media_key: "movie:3", liked: false, watched: true, genre_ids: [27])
    MovieRating.create!(user: @two, media_key: "movie:4", liked: true, genre_ids: [35])

    taste = TasteProfile.new([@one.id, @two.id])
    assert taste.group_score([35]) > 0
    assert taste.group_score([27]) < 0
    assert_equal [35], taste.top_genres
  end

  test "later swipes never overwrite an already-watched rating" do
    MovieRating.record_watched(@one, "movie:9", liked: true, genre_ids: [18])
    MovieRating.record_swipe(@one, "movie:9", liked: false)

    rating = MovieRating.find_by!(user: @one, media_key: "movie:9")
    assert rating.liked
    assert rating.watched
    assert_equal [18], rating.genre_ids
  end
end
