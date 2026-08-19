require "test_helper"

class ShopControllerTest < ActionDispatch::IntegrationTest
  test "catalog lists WannaWatch+ without requiring auth" do
    get shop_catalog_url
    assert_response :success

    body = JSON.parse(response.body)
    ids = body["products"].map { |p| p["id"] }
    assert_equal ["wannawatch_plus"], ids
    assert_equal "$2.99/mo", body["products"].first["price_label"]
    assert_equal "subscription", body["products"].first["kind"]
    assert_equal 40, body["swipe_ad_interval"]
    assert_includes body["copy"]["subhead"], "$2.99"
    assert_not body.key?("demo_unlock_allowed")
  end

  test "checkout requires an account email" do
    user = users(:one)
    post shop_checkout_url, params: { product_id: "wannawatch_plus", user_id: user.id }, as: :json
    assert_response :unprocessable_entity
    assert JSON.parse(response.body)["needs_account"]
  end

  test "legacy product ids still resolve to WannaWatch+" do
    assert_equal "wannawatch_plus", ShopCatalog.find("supporter").id
    assert_equal "wannawatch_plus", ShopCatalog.find("remove_ads").id
  end

  test "portal requires an existing subscription" do
    user = users(:two)
    user.update!(email: "buyer@example.com")

    post shop_portal_url, params: { user_id: user.id }, as: :json
    assert_response :unprocessable_entity
  end
end
