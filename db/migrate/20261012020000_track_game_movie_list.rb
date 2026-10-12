class TrackGameMovieList < ActiveRecord::Migration[7.1]
  def change
    add_column :games, :invite_sent_at, :datetime

    create_table :game_movies do |t|
      t.references :game, null: false, foreign_key: true
      t.string :media_key, null: false
      t.integer :position, null: false
      t.jsonb :payload, null: false, default: {}
      t.timestamps
    end

    add_index :game_movies, [:game_id, :media_key], unique: true
    add_index :game_movies, [:game_id, :position], unique: true
  end
end