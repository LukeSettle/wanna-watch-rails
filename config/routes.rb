Rails.application.routes.draw do
  post 'users/upsert'
  get 'users/find_by_device_id'
  get 'friends/index'
  get 'friends/movie_ids'

  resources :games, only: [:index] do
    member do
      post :finish
      post :join
      post :ready
      post :finish_matching
      get :deck
    end
  end
  get 'games/previous'
  post 'games/upsert'
  get 'games/find_by_entry_code'
  post 'games/keep_playing'

  get 'home', to: 'application#home'
  root to: 'web#show'
end
