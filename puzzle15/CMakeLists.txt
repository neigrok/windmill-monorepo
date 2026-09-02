cmake_minimum_required(VERSION 4.2)
project(puzzle15)

set(CMAKE_CXX_STANDARD 26)

add_executable(puzzle15 main.cpp
        Grid.cpp
        Grid.h)
