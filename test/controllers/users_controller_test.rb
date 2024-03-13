require "test_helper"

class UsersControllerTest < ActionDispatch::IntegrationTest
  test "should get create" do
    get users_create_url
    assert_response :success
  end

  test "should get update" do
    get users_update_url
    assert_response :success
  end

  test "should get find_by_device_id" do
    get users_find_by_device_id_url
    assert_response :success
  end
end
