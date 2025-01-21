class FriendsController < ApiController
  def index
    user = User.find(params[:user_id])

    render json: user.friends, status: :ok
  end

  def movie_ids
    user = User.find(params[:user_id])
    friend = User.find(params[:friend_id])
    our_game_ids = user
                   .games
                   .distinct
                   .joins(:players)
                   .where(players: { user_id: [friend.id, user.id] })
                   .pluck(:id)

    friends_liked_movie_ids = Game.where(id: our_game_ids)
                                  .joins(:players)
                                  .where(players: { user_id: friend.id })
                                  .pluck('players.liked_movie_ids')
                                  .flatten
                                  .uniq

    my_liked_movie_ids = Game.where(id: our_game_ids)
                             .joins(:players)
                             .where(players: { user_id: user.id })
                             .pluck('players.liked_movie_ids')
                             .flatten
                             .uniq

    our_liked_movie_ids = my_liked_movie_ids & friends_liked_movie_ids

    render json: {
      myLikedMovieIds: my_liked_movie_ids,
      friendsLikedMovieIds: friends_liked_movie_ids,
      ourLikedMovieIds: our_liked_movie_ids
     }, status: :ok
  end
end