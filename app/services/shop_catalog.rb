# Frozen product catalog for Stripe Checkout (price_data — no Dashboard price IDs required).
module ShopCatalog
  Product = Struct.new(
    :id, :name, :tagline, :description, :amount_cents, :kind, :entitlement_keys,
    keyword_init: true
  ) do
    def price_label
      format("$%<dollars>0.2f", dollars: amount_cents / 100.0)
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
        entitlement_keys: entitlement_keys
      }
    end
  end

  PRODUCTS = [
    Product.new(
      id: "supporter",
      name: "WannaWatch Supporter",
      tagline: "Lifetime · removes ads · supporter badge",
      description: "One-time thank-you that keeps movie night free for everyone. Removes the small banners, adds a supporter badge, and funds indie development.",
      amount_cents: 499,
      kind: "lifetime",
      entitlement_keys: %w[supporter ad_free]
    ),
    Product.new(
      id: "match_vault",
      name: "Match Vault",
      tagline: "Save & export your matches",
      description: "Keep a personal vault of titles you matched on, revisit them later, and export a list for your next movie night.",
      amount_cents: 299,
      kind: "unlock",
      entitlement_keys: %w[match_vault]
    ),
    Product.new(
      id: "deep_dive",
      name: "Deep Dive Cards",
      tagline: "Extra cast, trivia & where-to-watch",
      description: "Richer detail sheets for movie lovers — more cast, taglines, trivia-ish facts, and streaming context when you open a title.",
      amount_cents: 199,
      kind: "unlock",
      entitlement_keys: %w[deep_dive]
    ),
    Product.new(
      id: "lobby_flair",
      name: "Lobby Flair",
      tagline: "A little sparkle in the lobby",
      description: "Cosmetic delight only: a flair badge next to your name on home and in lobbies. Zero gameplay advantage.",
      amount_cents: 99,
      kind: "unlock",
      entitlement_keys: %w[lobby_flair]
    ),
    Product.new(
      id: "tip_popcorn",
      name: "Buy us popcorn",
      tagline: "Tip jar · no unlock required",
      description: "Just a warm thank-you. No entitlement, no pressure — popcorn for the people building WannaWatch.",
      amount_cents: 300,
      kind: "tip",
      entitlement_keys: []
    )
  ].freeze

  def self.all
    PRODUCTS
  end

  def self.find(product_id)
    PRODUCTS.find { |p| p.id == product_id.to_s }
  end

  def self.stripe_configured?
    ENV["STRIPE_SECRET_KEY"].present?
  end

  def self.demo_unlock_allowed?
    Rails.env.development? || Rails.env.test? || ENV["SHOP_DEMO_UNLOCK"].present?
  end
end
