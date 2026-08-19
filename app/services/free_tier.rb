# Limits for users without WannaWatch+. History is still stored on games so
# buying + later reveals the full library; the free UI only shows the latest.
module FreeTier
  HISTORY_LIMIT = 10
  FINE_TUNE_PARAM_KEYS = %w[with_original_language].freeze

  def self.sanitize_game_query(query_json)
    parsed = JSON.parse(query_json.to_s)
    params = parsed["params"]
    return query_json unless params.is_a?(Hash)

    FINE_TUNE_PARAM_KEYS.each { |key| params.delete(key) }
    parsed.to_json
  rescue JSON::ParserError, TypeError
    query_json
  end
end
