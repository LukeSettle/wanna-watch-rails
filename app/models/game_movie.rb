class GameMovie < ApplicationRecord
  belongs_to :game

  validates :media_key, presence: true, uniqueness: { scope: :game_id }
  validates :position, presence: true, uniqueness: { scope: :game_id }
end