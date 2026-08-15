require "test_helper"

class DeckBuilderTest < ActiveSupport::TestCase
  setup do
    @user = users(:one)
    @game = games(:one)
    @game.update!(
      user: @user,
      load_more_count: 0,
      dealt_movie_ids: [],
      query: {
        params: {
          "with_watch_providers" => "8",
          "watch_region" => "US",
          "vote_average.gte" => 0,
        },
      }.to_json
    )
    players(:one).update!(game: @game, user: @user, liked_movie_ids: [], seen_movie_ids: [])
  end

  test "discover requests include flatrate monetization when providers are set" do
    captured = []
    fake_movie = ->(id) {
      {
        "id" => id,
        "title" => "Title #{id}",
        "poster_path" => "/p.jpg",
        "adult" => false,
        "release_date" => "2020-01-01",
        "vote_average" => 7.0,
        "vote_count" => 2000,
        "genre_ids" => [28],
      }
    }

    with_tmdb(
      discover: ->(params, media: "movie") {
        captured << params
        [fake_movie.call(100 + captured.size)]
      },
      watch_providers: ->(*) { { "US" => { "flatrate" => [{ "provider_id" => 8 }] } } }
    ) do
      DeckBuilder.new(@game).build
    end

    assert captured.any?, "expected discover to be called"
    assert captured.all? { |p| p["with_watch_providers"] == "8" }
    assert captured.all? { |p| p["watch_region"] == "US" }
    assert captured.all? { |p| p["with_watch_monetization_types"] == "flatrate" }
  end

  test "deck excludes titles not on selected providers" do
    on_netflix = {
      "id" => 101,
      "title" => "On Netflix",
      "poster_path" => "/a.jpg",
      "adult" => false,
      "release_date" => "2019-06-01",
      "vote_average" => 7.5,
      "vote_count" => 5000,
      "genre_ids" => [18],
    }
    not_on_netflix = {
      "id" => 202,
      "title" => "Not On Netflix",
      "poster_path" => "/b.jpg",
      "adult" => false,
      "release_date" => "2018-06-01",
      "vote_average" => 7.8,
      "vote_count" => 5000,
      "genre_ids" => [18],
    }

    with_tmdb(
      discover: ->(*) { [not_on_netflix, on_netflix] },
      watch_providers: ->(id, media: "movie") {
        if id == 101
          { "US" => { "flatrate" => [{ "provider_id" => 8 }] } }
        else
          { "US" => { "flatrate" => [{ "provider_id" => 15 }], "rent" => [{ "provider_id" => 8 }] } }
        end
      }
    ) do
      deck = DeckBuilder.new(@game).build
      assert deck.any?
      assert deck.all? { |m| m["id"] == 101 }
    end
  end

  test "no provider filter when providers are not selected" do
    @game.update!(query: { params: { "vote_average.gte" => 0 } }.to_json)
    movie = {
      "id" => 303,
      "title" => "Anywhere",
      "poster_path" => "/c.jpg",
      "adult" => false,
      "release_date" => "2021-01-01",
      "vote_average" => 7.0,
      "vote_count" => 5000,
      "genre_ids" => [28],
    }
    watch_calls = 0

    with_tmdb(
      discover: ->(*) { [movie] },
      watch_providers: ->(*) {
        watch_calls += 1
        {}
      }
    ) do
      deck = DeckBuilder.new(@game).build
      assert deck.any? { |m| m["id"] == 303 }
      assert_equal 0, watch_calls
    end
  end

  private

  def with_tmdb(discover:, watch_providers:)
    originals = {
      discover: TmdbClient.method(:discover),
      recommendations: TmdbClient.method(:recommendations),
      tv_recommendations: TmdbClient.method(:tv_recommendations),
      watch_providers: TmdbClient.method(:watch_providers),
    }

    TmdbClient.define_singleton_method(:discover, discover)
    TmdbClient.define_singleton_method(:recommendations, ->(*) { [] })
    TmdbClient.define_singleton_method(:tv_recommendations, ->(*) { [] })
    TmdbClient.define_singleton_method(:watch_providers, watch_providers)

    yield
  ensure
    originals.each do |name, method|
      TmdbClient.define_singleton_method(name, method)
    end
  end
end
