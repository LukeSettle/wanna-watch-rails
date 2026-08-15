require "net/http"

class TmdbClient
  API_KEY = ENV.fetch("TMDB_API_KEY", "fd1efe23da588e99056fdb264ca89bbd")
  BASE_URL = "https://api.themoviedb.org/3"

  def self.get(path, params = {})
    uri = URI("#{BASE_URL}#{path}")
    uri.query = URI.encode_www_form(params.merge(api_key: API_KEY))

    response = Net::HTTP.get_response(uri)
    return {} unless response.is_a?(Net::HTTPSuccess)

    JSON.parse(response.body)
  rescue StandardError => e
    Rails.logger.warn("TMDB request failed: #{e.message}")
    {}
  end

  def self.discover(params = {}, media: "movie")
    path = media.to_s == "tv" ? "/discover/tv" : "/discover/movie"
    get(path, params)["results"] || []
  end

  def self.recommendations(movie_id)
    get("/movie/#{movie_id}/recommendations")["results"] || []
  end

  def self.tv_recommendations(tv_id)
    get("/tv/#{tv_id}/recommendations")["results"] || []
  end

  # Region hash: { "US" => { "flatrate" => [...], "rent" => [...], ... }, ... }
  def self.watch_providers(id, media: "movie")
    path = media.to_s == "tv" ? "/tv/#{id}/watch/providers" : "/movie/#{id}/watch/providers"
    get(path)["results"] || {}
  end
end
