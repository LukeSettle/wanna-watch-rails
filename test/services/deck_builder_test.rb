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

  test "legacy apple tv store id remaps to apple tv subscription" do
    query = JSON.parse(@game.query)
    query["params"]["with_watch_providers"] = "2"
    @game.update!(query: query.to_json)

    apple_title = {
      "id" => 3501,
      "title" => "On Apple TV",
      "poster_path" => "/a.jpg",
      "adult" => false,
      "release_date" => "2021-01-01",
      "vote_average" => 7.5,
      "vote_count" => 5000,
      "genre_ids" => [18],
    }
    store_only = {
      "id" => 3502,
      "title" => "Rent Only",
      "poster_path" => "/b.jpg",
      "adult" => false,
      "release_date" => "2021-01-01",
      "vote_average" => 7.5,
      "vote_count" => 5000,
      "genre_ids" => [18],
    }

    captured = []
    with_tmdb(
      discover: ->(params, media: "movie") {
        captured << params
        [store_only, apple_title]
      },
      watch_providers: ->(id, media: "movie") {
        if id == 3501
          { "US" => { "flatrate" => [{ "provider_id" => 350 }] } }
        else
          { "US" => { "rent" => [{ "provider_id" => 2 }], "buy" => [{ "provider_id" => 2 }] } }
        end
      }
    ) do
      deck = DeckBuilder.new(@game).build
      assert deck.any?
      assert deck.all? { |m| m["id"] == 3501 }
    end

    assert captured.any?
    assert captured.all? { |p| p["with_watch_providers"] == "350" }
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

  test "deck keeps filling from deeper catalog pages when the usual pools are used up" do
    @game.update!(query: { params: { "vote_average.gte" => 0 } }.to_json)
    seen = (1..40).map { |id| "movie:#{id}" }
    players(:one).update!(seen_movie_ids: seen)
    catalog = (1..1000).map { |id| movie(id) }

    with_tmdb(
      discover: ->(params, media: "movie") {
        page = params["vote_count.gte"] == 50 ? params["page"].to_i : 1
        catalog.slice((page - 1) * 20, 20)
      },
      discover_page: ->(params, media: "movie") {
        { "results" => catalog.first(20), "total_pages" => 50 }
      },
      watch_providers: ->(*) { {} }
    ) do
      deck = DeckBuilder.new(@game).build
      assert_equal DeckBuilder::DECK_SIZE, deck.size
      assert (deck.map { |m| MediaKey.for(m) } & seen).empty?
    end
  end

  test "recommendations seeded by every player's likes rank titles that fit the whole group first" do
    other = users(:two)
    Player.create!(user: other, game: @game)
    @game.update!(query: { params: { "vote_average.gte" => 0, "ww_for_you" => "true" } }.to_json)

    MovieRating.create!(user: @user, media_key: "movie:900", liked: true, genre_ids: [35])
    MovieRating.create!(user: other, media_key: "movie:901", liked: true, genre_ids: [35])
    MovieRating.create!(user: other, media_key: "movie:902", liked: false, watched: true, genre_ids: [27])

    comedy = movie(500, genre_ids: [35])
    horror = movie(501, genre_ids: [27])
    shared_pick = movie(502, genre_ids: [35, 18])
    seeds = []

    with_tmdb(
      discover: ->(*) { [] },
      recommendations: ->(id) {
        seeds << id
        id == 900 ? [horror, comedy, shared_pick] : [shared_pick]
      },
      watch_providers: ->(*) { {} }
    ) do
      deck = DeckBuilder.new(@game).build
      ids = deck.map { |m| m["id"] }
      assert_equal [900, 901].sort, seeds.sort
      assert_equal 502, ids.first
      assert ids.index(500) < ids.index(501)
    end
  end

  test "titles rated as already watched are never dealt" do
    MovieRating.create!(user: @user, media_key: "movie:77", liked: true, watched: true)
    @game.update!(query: { params: { "vote_average.gte" => 0 } }.to_json)

    results = [movie(77), movie(78)]

    with_tmdb(discover: ->(*) { results }, watch_providers: ->(*) { {} }) do
      ids = DeckBuilder.new(@game).build.map { |m| m["id"] }
      assert_not_includes ids, 77
      assert_includes ids, 78
    end
  end

  private

  def movie(id, genre_ids: [28])
    {
      "id" => id,
      "title" => "Title #{id}",
      "poster_path" => "/p.jpg",
      "adult" => false,
      "release_date" => "2020-01-01",
      "vote_average" => 7.0,
      "vote_count" => 2000,
      "genre_ids" => genre_ids,
    }
  end

  def with_tmdb(discover:, watch_providers:, details: nil, discover_page: nil, recommendations: nil)
    originals = {
      discover: TmdbClient.method(:discover),
      discover_page: TmdbClient.method(:discover_page),
      recommendations: TmdbClient.method(:recommendations),
      tv_recommendations: TmdbClient.method(:tv_recommendations),
      watch_providers: TmdbClient.method(:watch_providers),
      details: TmdbClient.method(:details),
    }

    TmdbClient.define_singleton_method(:discover, discover)
    TmdbClient.define_singleton_method(:discover_page, discover_page || ->(params, media: "movie") {
      { "results" => discover.call(params, media: media), "total_pages" => 1 }
    })
    TmdbClient.define_singleton_method(:recommendations, recommendations || ->(*) { [] })
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
