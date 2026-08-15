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

  test "kids off applies US certification filters on discover" do
    @game.update!(
      query: {
        params: {
          "exclude_kids" => "true",
          "vote_average.gte" => 0,
        },
      }.to_json
    )
    captured = []

    with_tmdb(
      discover: ->(params, media: "movie") {
        captured << [media, params]
        [{
          "id" => 401,
          "title" => "Adultish",
          "poster_path" => "/d.jpg",
          "adult" => false,
          "release_date" => "2019-01-01",
          "vote_average" => 7.2,
          "vote_count" => 4000,
          "genre_ids" => [28],
        }]
      },
      watch_providers: ->(*) { {} }
    ) do
      DeckBuilder.new(@game).build
    end

    assert captured.any?
    assert captured.all? { |_media, params| params["certification_country"] == "US" }
    assert captured.all? { |_media, params| params["certification.gte"] == "PG" }
  end

  test "excluded keys distinguish movie and tv with the same id" do
    players(:one).update!(liked_movie_ids: ["movie:550"], seen_movie_ids: [])
    @game.update!(
      dealt_movie_ids: ["tv:550"],
      query: { params: { "vote_average.gte" => 0, "media_type" => "both" } }.to_json
    )

    movie_hit = {
      "id" => 550,
      "title" => "Movie 550",
      "poster_path" => "/m.jpg",
      "adult" => false,
      "release_date" => "2018-01-01",
      "vote_average" => 7.5,
      "vote_count" => 5000,
      "genre_ids" => [18],
    }
    tv_hit = {
      "id" => 550,
      "name" => "TV 550",
      "poster_path" => "/t.jpg",
      "adult" => false,
      "first_air_date" => "2017-01-01",
      "vote_average" => 7.5,
      "vote_count" => 5000,
      "genre_ids" => [18],
    }

    with_tmdb(
      discover: ->(_params, media: "movie") { media == "tv" ? [tv_hit] : [movie_hit] },
      watch_providers: ->(*) { {} }
    ) do
      deck = DeckBuilder.new(@game).build
      keys = deck.map { |m| MediaKey.for(m) }
      assert_not_includes keys, "movie:550"
      assert_not_includes keys, "tv:550"
    end
  end

  test "curate keys build a deck from the shared list" do
    @game.update!(
      query: {
        params: {
          "ww_curate_keys" => "movie:11,tv:1396",
          "vote_average.gte" => 0,
        },
      }.to_json
    )

    with_tmdb(
      discover: ->(*) { flunk "discover should not run in curate mode" },
      watch_providers: ->(*) { {} },
      details: ->(id, media: "movie") {
        {
          "id" => id,
          "title" => media == "tv" ? nil : "Curated #{id}",
          "name" => media == "tv" ? "Curated TV #{id}" : nil,
          "poster_path" => "/c.jpg",
          "adult" => false,
          "release_date" => "2020-01-01",
          "first_air_date" => "2019-01-01",
        }
      }
    ) do
      deck = DeckBuilder.new(@game).build
      keys = deck.map { |m| MediaKey.for(m) }
      assert_equal ["movie:11", "tv:1396"].sort, keys.sort
    end
  end

  private

  def with_tmdb(discover:, watch_providers:, details: nil)
    originals = {
      discover: TmdbClient.method(:discover),
      recommendations: TmdbClient.method(:recommendations),
      tv_recommendations: TmdbClient.method(:tv_recommendations),
      watch_providers: TmdbClient.method(:watch_providers),
      details: TmdbClient.method(:details),
    }

    TmdbClient.define_singleton_method(:discover, discover)
    TmdbClient.define_singleton_method(:recommendations, ->(*) { [] })
    TmdbClient.define_singleton_method(:tv_recommendations, ->(*) { [] })
    TmdbClient.define_singleton_method(:watch_providers, watch_providers)
    TmdbClient.define_singleton_method(:details, details || ->(*) { {} })

    yield
  ensure
    originals.each do |name, method|
      TmdbClient.define_singleton_method(name, method)
    end
  end
end
