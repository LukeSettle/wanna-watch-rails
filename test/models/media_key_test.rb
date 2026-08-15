require "test_helper"

class MediaKeyTest < ActiveSupport::TestCase
  test "joins media and id" do
    assert_equal "movie:550", MediaKey.join("movie", 550)
    assert_equal "tv:1396", MediaKey.join("tv", 1396)
  end

  test "normalizes legacy integers as movies" do
    assert_equal "movie:550", MediaKey.normalize(550)
    assert_equal ["movie:1", "tv:2"], MediaKey.normalize_list([1, "tv:2"])
  end

  test "parses composite keys" do
    assert_equal ["tv", 1396], MediaKey.parse("tv:1396")
    assert_equal ["movie", 10], MediaKey.parse(10)
  end
end
