// The product-neutral core the native superapp shares across products — the mirror of the web
// shell + packages/api-contract. A product module conforms to ProductModule to be mountable; the
// app composes whichever modules exist behind one Account (one sign-in, one subscription).

public protocol ProductModule {
    var id: String { get }
    var label: String { get }
}

public struct Account {
    public let apiBaseURL: String
    public init(apiBaseURL: String) { self.apiBaseURL = apiBaseURL }
}

public struct Superapp {
    public let account: Account
    public let products: [ProductModule]
    public init(account: Account, products: [ProductModule]) {
        self.account = account
        self.products = products
    }
    public var mounted: [String] { products.map { $0.label } }
}
