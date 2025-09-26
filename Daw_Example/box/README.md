_This package is part of the openDAW SDK_

# @opendaw/lib-box

Graph-based object modeling system with serialization, transactions, and pointer management for TypeScript projects.

## Wishlist

* Introduce readonly fields (cannot only be written in the constructing phase)
* Introduce meta-fields (compile time only)
* Add array with all TypeMap keys

## Core Architecture

* **box.ts** - Core Box class for graph nodes with field management
* **vertex.ts** - Vertex interface and visitor pattern definitions
* **graph.ts** - BoxGraph class for managing object relationships
* **field.ts** - Field abstraction for object properties
* **address.ts** - Addressing system for graph navigation

## Field Types

* **primitive.ts** - Primitive field types (boolean, number, string)
* **array.ts** - Array field implementations
* **object.ts** - Object field for nested structures
* **pointer.ts** - Pointer field for object references

## Graph Management

* **graph-edges.ts** - Edge management for graph relationships
* **pointer-hub.ts** - Hub for managing incoming pointer connections
* **dispatchers.ts** - Event dispatching system for updates
* **updates.ts** - Update event definitions and handling

## Serialization & Persistence

* **serializer.ts** - Serialization utilities for objects
* **sync.ts** - Synchronization utilities
* **sync-source.ts** - Source-side synchronization
* **sync-target.ts** - Target-side synchronization

## Editing & Transactions

* **editing.ts** - Undo/redo system for graph modifications
* **indexed-box.ts** - Indexed box implementation for efficient lookups