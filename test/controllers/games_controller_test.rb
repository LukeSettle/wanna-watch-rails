require "test_helper"

class GamesControllerTest < ActionDispatch::IntegrationTest
  include ActiveSupport::Testing::TimeHelpers

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

  test "swipes build the user's taste profile and undo removes the rating" do
    @game.update!(mode: "endless", deck: [{ "id" => 550, "media_type" => "movie", "genre_ids" => [18] }])
    players(:one).update!(liked_movie_ids: [], seen_movie_ids: [])

    post swipe_game_url(@game), params: { user_id: @owner.id, movie_id: 550, liked: true }, as: :json

    rating = MovieRating.find_by!(user: @owner, media_key: "movie:550")
    assert rating.liked
    assert_equal [18], rating.genre_ids

    post undo_swipe_game_url(@game), params: { user_id: @owner.id, movie_id: 550 }, as: :json
    assert_not MovieRating.exists?(user: @owner, media_key: "movie:550")
  end

  test "watched removes the title from the deck without counting as a game like" do
    player = players(:one)
    player.update!(liked_movie_ids: [], seen_movie_ids: [])

    post watched_game_url(@game), params: { user_id: @owner.id, movie_id: 680, liked: true }, as: :json

    assert_response :success
    player.reload
    assert_includes player.seen_movie_ids, "movie:680"
    assert_not_includes player.liked_movie_ids, "movie:680"
    rating = MovieRating.find_by!(user: @owner, media_key: "movie:680")
    assert rating.watched
    assert rating.liked

    post finish_matching_game_url(@game), params: {
      user_id: @owner.id, liked_movie_ids: [], seen_movie_ids: ["movie:680"]
    }, as: :json
    assert rating.reload.liked
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

  test "upsert strips fine-tune language for free users" do
    query = { params: { "with_genres" => "35", "with_original_language" => "ja" } }.to_json

    post games_upsert_url, params: {
      game: {
        entry_code: "FREE01",
        query: query,
        user_id: @owner.id,
        mode: "first_match"
      }
    }, as: :json

    assert_response :success
    parsed = JSON.parse(Game.find_by!(entry_code: "FREE01").query)
    assert_equal "35", parsed.dig("params", "with_genres")
    assert_nil parsed.dig("params", "with_original_language")
  end

  test "host cannot start until they have asked someone to join" do
    post begin_game_url(@game), params: { user_id: @owner.id }, as: :json

    assert_response :unprocessable_entity
    assert_nil @game.reload.started_at
  end

  test "host can start after inviting a friend who has not joined" do
    GameInvite.create!(game: @game, inviter: @owner, invitee: @other)
    assert_equal 1, @game.players.count

    post begin_game_url(@game), params: { user_id: @owner.id }, as: :json

    assert_response :success
    assert @game.reload.started_at.present?
  end

  test "host can start after a friend declines, because they already asked" do
    invite = GameInvite.create!(game: @game, inviter: @owner, invitee: @other)
    invite.decline!

    post begin_game_url(@game), params: { user_id: @owner.id }, as: :json

    assert_response :success
    assert @game.reload.started_at.present?
  end

  test "sharing the game link lets the host start before anyone joins" do
    post share_game_url(@game), params: { user_id: @owner.id }, as: :json

    assert_response :success
    assert @game.reload.invite_sent_at.present?

    post begin_game_url(@game), params: { user_id: @owner.id }, as: :json

    assert_response :success
    assert @game.reload.started_at.present?
  end

  test "a friend who has already joined can still be started by the host" do
    Player.create!(user: @other, game: @game)

    post begin_game_url(@game), params: { user_id: @owner.id }, as: :json

    assert_response :success
  end

  test "only the host can start the game" do
    @game.update!(invite_sent_at: Time.current)

    post begin_game_url(@game), params: { user_id: @other.id }, as: :json

    assert_response :forbidden
    assert_nil @game.reload.started_at
  end

  test "classic decks are stored on the game movie list" do
    @game.update!(mode: "classic", deck: [], deck_round: -1, load_more_count: 0, dealt_movie_ids: [], finished_at: nil)
    movie = movie_payload(42)

    with_deck_batches([[movie]]) do
      get deck_game_url(@game), params: { user_id: @owner.id }
      assert_response :success
      get deck_game_url(@game), params: { user_id: @owner.id }
      assert_response :success
    end

    assert_equal [movie], JSON.parse(response.body)["movies"]
    assert_equal ["movie:42"], @game.game_movies.order(:position).pluck(:media_key)
    assert_equal ["movie:42"], @game.reload.dealt_movie_ids
  end

  test "a friend who joins later gets the same movies the host already swiped" do
    @game.update!(
      mode: "first_match",
      deck: [],
      deck_round: -1,
      load_more_count: 0,
      dealt_movie_ids: [],
      finished_at: nil,
      started_at: Time.current
    )
    host = players(:one)
    host.update!(game: @game, user: @owner, liked_movie_ids: [], seen_movie_ids: [], finished_at: nil)

    batches = Array.new(8) do |batch|
      Array.new(20) { |index| movie_payload(batch * 20 + index + 1) }
    end

    swiped = []
    with_deck_batches(batches) do
      while swiped.size < 100
        movies = fetch_deck(@owner)
        assert movies.any?, "expected another page of movies"
        movies.each do |movie|
          break if swiped.size >= 100

          post swipe_game_url(@game), params: {
            user_id: @owner.id,
            movie_id: movie["id"],
            media_type: movie["media_type"],
            liked: true
          }, as: :json
          assert_response :success
          swiped << MediaKey.for(movie)
        end
      end

      original = @game.game_movies.order(:position).pluck(:media_key)
      assert_equal swiped, original
      assert_equal 100, original.size

      # Asking for more after everything has been swiped used to delete seen
      # titles. They have to stay so a later joiner can swipe them too.
      more = fetch_deck(@owner)
      assert more.any?
      assert_equal original, @game.game_movies.order(:position).limit(original.size).pluck(:media_key)
      assert_operator @game.game_movies.count, :>, original.size

      travel 1.day do
        post join_game_url(@game), params: { user_id: @other.id }, as: :json
        assert_response :success

        friend = Player.find_by!(user: @other, game: @game)
        assert_empty friend.seen_movie_ids

        collected = []
        while collected.size < original.size
          page = fetch_deck(@other)
          fresh = page.map { |movie| MediaKey.for(movie) }.reject { |key| collected.include?(key) }
          assert fresh.any?, "friend ran out of movies before seeing the host's list"
          collected.concat(fresh)
          friend.update!(seen_movie_ids: collected)
        end

        assert_equal original, collected.first(original.size)
        assert_equal original, @game.game_movies.order(:position).limit(original.size).pluck(:media_key)
        assert_equal "Movie 1", @game.game_movies.order(:position).first.payload["title"]
      end
    end
  end

  test "upsert keeps fine-tune language for plus users" do
    @owner.apply_entitlements!(%w[plus ad_free])
    query = { params: { "with_genres" => "35", "with_original_language" => "ja" } }.to_json

    post games_upsert_url, params: {
      game: {
        entry_code: "PLUS01",
        query: query,
        user_id: @owner.id,
        mode: "first_match"
      }
    }, as: :json

    assert_response :success
    parsed = JSON.parse(Game.find_by!(entry_code: "PLUS01").query)
    assert_equal "ja", parsed.dig("params", "with_original_language")
  end

  private

  def movie_payload(id)
    {
      "id" => id,
      "title" => "Movie #{id}",
      "poster_path" => "/p#{id}.jpg",
      "overview" => "Overview #{id}",
      "adult" => false,
      "release_date" => "2020-01-01",
      "vote_average" => 7.5,
      "vote_count" => 2000,
      "genre_ids" => [18],
      "media_type" => "movie",
    }
  end

  def fetch_deck(user)
    get deck_game_url(@game), params: { user_id: user.id }
    assert_response :success
    JSON.parse(response.body).fetch("movies")
  end

  def with_deck_batches(batches)
    cursor = 0
    builder = Object.new
    builder.define_singleton_method(:build) do
      batch = batches[cursor] || []
      cursor += 1
      batch
    end

    original = DeckBuilder.method(:new)
    DeckBuilder.define_singleton_method(:new) { |*| builder }
    yield
  ensure
    DeckBuilder.define_singleton_method(:new) { |*args, **kwargs, &block| original.call(*args, **kwargs, &block) } if original
  end
end
