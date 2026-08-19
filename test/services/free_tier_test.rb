require "test_helper"

class FreeTierTest < ActiveSupport::TestCase
  test "strips fine-tune language from free-tier game queries" do
    query = {
      method: "GET",
      params: {
        "media_type" => "movie",
        "with_genres" => "35",
        "with_original_language" => "ja"
      }
    }.to_json

    sanitized = JSON.parse(FreeTier.sanitize_game_query(query))

    assert_equal "35", sanitized.dig("params", "with_genres")
    assert_nil sanitized.dig("params", "with_original_language")
  end

  test "leaves invalid JSON alone" do
    assert_equal "not-json", FreeTier.sanitize_game_query("not-json")
  end
end
