require "test_helper"

class ShopControllerTest < ActionDispatch::IntegrationTest
  test "catalog lists products without requiring auth" do
    get shop_catalog_url
    assert_response :success

    body = JSON.parse(response.body)
    ids = body["products"].map { |p| p["id"] }
    assert_includes ids, "supporter"
    assert_includes ids, "tip_popcorn"
    assert_includes body["copy"]["headline"], "movie lovers"
  end

  test "checkout requires an account email" do
    user = users(:one)
    post shop_checkout_url, params: { product_id: "supporter", user_id: user.id }, as: :json
    assert_response :unprocessable_entity
    assert JSON.parse(response.body)["needs_account"]
  end

  test "demo unlock grants entitlement in test" do
    user = users(:two)
    user.update!(email: "buyer@example.com")

    post shop_demo_unlock_url, params: { product_id: "deep_dive", user_id: user.id }, as: :json
    assert_response :success

    body = JSON.parse(response.body)
    assert body["entitlements"]["deep_dive"]
    assert user.reload.has_entitlement?("deep_dive")
  end

  test "demo unlock unknown product is not found" do
    user = users(:one)
    post shop_demo_unlock_url, params: { product_id: "nope", user_id: user.id }, as: :json
    assert_response :not_found
  end
end
