require "test_helper"

class UserEntitlementsTest < ActiveSupport::TestCase
  test "granting supporter sets ad_free and entitlements" do
    user = users(:one)
    product = ShopCatalog.find("supporter")

    purchase = user.grant_product!(product, stripe_session_id: "cs_test_supporter_1")

    assert purchase.persisted?
    assert user.reload.ad_free?
    assert user.has_entitlement?("supporter")
    assert_equal "supporter", purchase.product_id
  end

  test "webhook-style grant is idempotent on stripe session" do
    user = users(:one)
    product = ShopCatalog.find("match_vault")

    first = user.grant_product!(product, stripe_session_id: "cs_test_vault_1")
    second = user.grant_product!(product, stripe_session_id: "cs_test_vault_1")

    assert_equal first.id, second.id
    assert_equal 1, user.purchases.where(product_id: "match_vault").count
    assert user.reload.has_entitlement?("match_vault")
  end

  test "tip increments counter without feature flag" do
    user = users(:one)
    product = ShopCatalog.find("tip_popcorn")

    user.grant_product!(product, stripe_session_id: "cs_test_tip_1")
    user.grant_product!(product, stripe_session_id: "cs_test_tip_2")

    assert_equal 2, user.reload.entitlements_hash["tips"]
    assert_not user.has_entitlement?("match_vault")
  end

  test "lobby flair picks a style" do
    user = users(:two)
    user.grant_product!(ShopCatalog.find("lobby_flair"), stripe_session_id: "cs_test_flair_1")

    assert user.reload.has_entitlement?("lobby_flair")
    assert_includes UserEntitlements::FLAIR_STYLES, user.entitlements_hash["flair_style"]
  end
end
