require "test_helper"

class UserEntitlementsTest < ActiveSupport::TestCase
  test "granting WannaWatch+ sets plus and ad_free" do
    user = users(:one)
    product = ShopCatalog.find("wannawatch_plus")

    purchase = user.grant_product!(product, stripe_session_id: "cs_test_plus_1")

    assert purchase.persisted?
    assert user.reload.ad_free?
    assert user.plus?
    assert user.has_entitlement?("plus")
    assert user.has_entitlement?("ad_free")
    assert_equal "wannawatch_plus", purchase.product_id
  end

  test "legacy remove_ads product id grants plus" do
    user = users(:one)
    product = ShopCatalog.find("remove_ads")

    user.grant_product!(product, stripe_session_id: "cs_test_remove_ads_1")

    assert user.reload.plus?
    assert user.ad_free?
    assert_equal "wannawatch_plus", user.purchases.last.product_id
  end

  test "webhook-style grant is idempotent on stripe session" do
    user = users(:one)
    product = ShopCatalog.find("wannawatch_plus")

    first = user.grant_product!(product, stripe_session_id: "cs_test_plus_1")
    second = user.grant_product!(product, stripe_session_id: "cs_test_plus_1")

    assert_equal first.id, second.id
    assert_equal 1, user.purchases.where(product_id: "wannawatch_plus").count
    assert user.reload.plus?
  end

  test "active stripe subscription grants plus" do
    user = users(:two)
    StripeBilling.apply_subscription!(user, {
      "id" => "sub_test_active",
      "status" => "active",
      "customer" => "cus_test_1"
    })

    assert user.reload.plus?
    assert user.ad_free?
    assert user.subscription_active?
    assert_equal "sub_test_active", user.stripe_subscription_id
  end

  test "canceled stripe subscription revokes plus" do
    user = users(:two)
    StripeBilling.apply_subscription!(user, {
      "id" => "sub_test_cancel",
      "status" => "active",
      "customer" => "cus_test_2"
    })
    StripeBilling.apply_subscription!(user, {
      "id" => "sub_test_cancel",
      "status" => "canceled",
      "customer" => "cus_test_2"
    })

    assert_not user.reload.plus?
    assert_not user.ad_free?
    assert_equal "canceled", user.subscription_status
  end
end
