require "test_helper"

class WebControllerTest < ActionDispatch::IntegrationTest
  test "configure and friend match screens are routable" do
    [
      "/",
      "/configure",
      "/movies",
      "/movies/likes",
      "/movies/friends",
      "/movies/friends/4",
    ].each do |path|
      get path
      assert_response :success, path
      assert_includes response.body, 'id="app"', path
    end
  end
end
