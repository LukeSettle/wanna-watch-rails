# Frozen product catalog for Stripe Checkout (price_data — no Dashboard price IDs required).
module ShopCatalog
  Product = Struct.new(
    :id, :name, :tagline, :description, :amount_cents, :kind, :interval, :entitlement_keys, :tax_code,
    keyword_init: true
  ) do
    def price_label
      dollars = format("$%<dollars>0.2f", dollars: amount_cents / 100.0)
      kind == "subscription" ? "#{dollars}/mo" : dollars
    end

    def as_json(*)
      {
        id: id,
        name: name,
        tagline: tagline,
        description: description,
        amount_cents: amount_cents,
        price_label: price_label,
        kind: kind,
        interval: interval,
        entitlement_keys: entitlement_keys
      }
    end
  end

  # Older checkouts may still send these product_ids via webhook/confirm.
  PRODUCT_ALIASES = {
    "supporter" => "wannawatch_plus",
    "remove_ads" => "wannawatch_plus"
  }.freeze

  PRODUCTS = [
    Product.new(
      id: "wannawatch_plus",
      name: "WannaWatch+",
      tagline: "Monthly subscription",
      description: "No ads, Fine-tune on custom games, and your full likes & matches history — while you're subscribed.",
      amount_cents: 299,
      kind: "subscription",
      interval: "month",
      entitlement_keys: %w[plus ad_free],
      # Hosted SaaS, personal use — https://docs.stripe.com/tax/digital-products
      tax_code: "txcd_10103000"
    )
  ].freeze

  def self.all
    PRODUCTS
  end

  def self.find(product_id)
    id = PRODUCT_ALIASES.fetch(product_id.to_s, product_id.to_s)
    PRODUCTS.find { |p| p.id == id }
  end

  def self.stripe_configured?
    ENV["STRIPE_SECRET_KEY"].present?
  end

  def self.swipe_ad_interval
    raw = ENV.fetch("AD_SWIPE_INTERVAL", "40").to_i
    raw.positive? ? raw : 40
  end
end
