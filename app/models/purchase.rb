class Purchase < ApplicationRecord
  belongs_to :user

  validates :product_id, presence: true
  validates :status, presence: true
end
