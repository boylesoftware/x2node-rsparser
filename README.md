# X2 Framework for Node.js | Result Set Parser

This module provides a parser for parsing SQL SELECT query result sets into complex data structures supported by JSON. The module is a part of X2 Framework.

The concept behind this parser is yet another take at the problem of mapping rigidly two-dimensional grids of values that are results produced by SQL SELECT queries into richly hierarchical, tree-like data structures, with which applications normally operate. The idea is to use particularly structured result sets with special syntax in the result set column labels that maps the column values to certain properties in the produced records on one hand. On the other hand, the parser is provided with the description of the supported records structure via the use of X2 Framework's [x2node-records](https://www.npmjs.com/package/x2node-records) module. The parser then can be fed with the result set rows one by one and build an array of the extracted records. In the simplest case, each row in the result set represents a single record of the given type and each column's label is the name of the record property, to which the column value maps. The parser implementation, however, supports far more complex cases including multiple levels of nested objects, polymorphic objects, reference properties and simulteneous fetch of the referred records, arrays and maps.

## Usage

The module exports a single class `RSParser`. An instance of the `RSParser` class can be configured once for a specific result set structure and then used to parse one result set at a time, accumulating extracted records in an internal array. Here is a simple example that uses [mysql](https://www.npmjs.com/package/mysql):

```javascript
const mysql = require('mysql');
const RecordTypesLibrary = require('x2node-records');
const RSParser = require('x2node-rsparser');

// create record types library
const recordTypes = new RecordTypesLibrary({
	'Person': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'firstName': {
				valueType: 'string'
			},
			'lastName': {
				valueType: 'string'
			}
		}
	}
});

// create parser to extract Person records
const parser = new RSParser(recordTypes, 'Person');

// connect to the database
const connection = mysql.createConnection({
	host: 'localhost',
	user: 'me',
	password: 'secret',
	database: 'my_db'
});
connection.connect(function(err) {
	if (err)
		throw err;
});

// create and run the query
connection.query(
	'SELECT id, fname AS firstName, lname AS lastName FROM persons'
)
.on('error', function(err) {
	throw err;
})
.on('fields', function(fields) {

	// configure the parser with the columns markup
	parser.init(fields.map(field => field.name));
})
.on('result', function(row) {

	// feed the row to the parser
	parser.feedRow(row);
})
.on('end', function() {

	// end connection to the database
	connection.end();

	// print extracted records
	console.log(JSON.stringify(parser.records));
});
```

The `RSParser` constructor takes two arguments: the application's record types library and the name of the record type being extracted from the result set.

Note the first requirement to the result set structure: *the first column of the result set must always be the record id*.

Then note how the parser is initialized in the `fields` event handler where it's fed with an array containing the property names for each result set column. The property names are specified as column labels in the SELECT query.

In the `result` event handler we feed the parser with the received result set rows.

When the query execution is complete, in the `end` event handler we have an array with extracted records available in the parser's `records` property.

## The API

The `RSParser` exposes the following properties and methods:

* `new RSParser(recordTypes, topRecordTypeName, [options])` - The constructor used to create a new parser. The first argument is an instance of `RecordTypesLibrary` provided by the [x2node-records](https://www.npmjs.com/package/x2node-records) module. The second argument is a string that specifies the name of the record type extracted bu the parser from the result set. The optional third argument is an object with options. At the moment, the parser itself only uses `valueExtractors` option discussed later in this section, but the options object is made available to any parser customization points and can be used to configure those.

  Note, that before a new parser instance can be used, it must be initialized with the result set column labels called the *columns markup*.

* `init(markup)` - Initialize the parser with columns markup. The markup is normally extracted from the result set column labels. The `markup` argument is an array of strings, one string per result set column. The markup syntax is discussed in detail later in this manual. Once the parser is initialized, result set rows can start to be fed to it for parsing.

* `feedRow(row)` - Feed a result set row to the parser. The `row` argument can be either an array of corresponding column values, or an object with keys being column labels (which are the column markup) and values being the corresponding values. Using array yields slightly better performance.

* `reset()` - Reset the parser so it can be used again for the same query. The reset does not erase the markup, so once the parser is initialized, it can only be used for the same result set structure. The reset only clears the perser's internal state and the accumulated records collections.

* `records` - A read-only property, which is an array of extracted records. Normally, it is accessed after all of the result set rows are fed to the parser. The `reset()` method creates a new instance of the array, so that the reference to the previous parsing results can still be used outside of the parser.

* `referredRecords` - The parser supports fetching records referred to by reference properties, all within the same result set as discussed later in this manual. The extracted referred records end up in this read-only property, which is an object with keys being the reference values (record type, hash sign, record id) and values being the record objects. It is a parsing result collection supplementary to the `records` property. The `reset()` method create a new instance of the referred records collection.

* `merge(otherParser)` - Merge `records` and `referredRecords` in the specified other parser into this one. The `otherParser` must be an instance of `RSParser` containing the same number of records of the same record type with the same ids and in the same order. Merging multiple parsers is used primarily to support loading data structures with multiple multi-element tree branches (having multiple array and/or map properties on the same nesting level). This topic is discussed later in this manual.

When the `feedRow(row)` method is called, the values in the provided `row` argument are considered "raw". Before a value from a result set column is set into the corresponding record property it is passed through a function called *value extractor*. The default value extractors can be overridden by providing custom extraction functions for the extractor types in the parser constructor's `options` argument. The option used for that is `valueExtractors`. The keys are extractor types and the values are corresponding extractor functions. The following extractor types are used:

* `string` - Used to extract string record properties. The default extractor simply returns the raw value.
* `number` - Used to extract number record properties. The default extractor simply returns the raw value.
* `boolean` - Used to extract Boolean record properties. The default extractor returns `null` if the raw value is `null`, otherwise it returns the result of `rawValue ? true : false` conditional operator.
* `datetime` - Used to extract datetime record properties. The default extractor simply returns the raw value.
* `isNull` - Special extractor used to test if the property value is `null`. The default extractor returns `true` if the raw value is `null`, or `false` if it is not.

The extractor functions receive the following arguments:

* `rawVal` - The raw value from the `row` argument provided to the parser's `feedRow(row)` method.
* `rowNum` - Zero-based result set row number.
* `colNum` - Zero-based result set column number.
* `options` - The options object originally passed to the parser constructor.

For example, if the database returns numbers as strings, a customer extractor could be used to fix that:

```javascript
const parser = new RSParser(recordTypes, 'Person', {
	valueExtractors: {
		'number': function(rawVal) {
			return (rawVal === null ? null : Number(rawVal));
		}
	}
});
```

## The Columns Markup

The result set column position and associated markup string drive the parser's logic of building records from the result set rows. The first column in the result set must always be for the record id property. Other record properties follow it. Different record structure scenarios are discussed next.

### Scalar Properties

When only scalar properties are used (no arrays and no maps) each row in the result set produces exactly one record. In each result set row the first column, which is always the record id, changes its value. Let's look at different scalar value types.

#### Simple Scalar Properties

In the case of simple scalar (single value) properties the column markup is simply the property name. For example, given a Person record type definition:

```javascript
{
	...
	'Person': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'firstName': {
				valueType: 'string'
			},
			'lastName': {
				valueType: 'string'
			}
		}
	},
	...
}
```

the markup for the columns can be simply:

```javascript
[ 'id', 'firstName', 'lastName' ]
```

If the table for storing Person records looks like:

```sql
CREATE TABLE persons (
	id INTEGER PRIMARY KEY,
	fname VARCHAR(30),
	lname VARCHAR(30)
)
```

the markup embedded in the query as column labels could be:

```sql
SELECT id, fname AS firstName, lname AS lastName FROM persons
```

The columns with `NULL` values leave the corresponding properties in the resulting record unset.

#### Nested Objects

With nested object properties we introduce the notion of nesting levels. The markup syntax uses a prefix string for properties that belong to the same object on a given nesting level. The prefix string is prepended to the property names in the markup and is separated from the property names with a dollar sign. Prefix string for a deeper nesting level *must* be longer than the prefix of the parent level. Let's consider the following record type definition with a nested object property:

```javascript
{
	...
	'Person': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'firstName': {
				valueType: 'string'
			},
			'lastName': {
				valueType: 'string'
			},
			'address': {
				valueType: 'object',
				properties: {
					'street': {
						valueType: 'string'
					},
					'city': {
						valueType: 'string'
					},
					'state': {
						valueType: 'string'
					},
					'zip': {
						valueType: 'string'
					}
				}
			}
		}
	},
	...
}
```

To select all these properties the markup can be:

```javascript
[
	'id', 'firstName', 'lastName', 'address',
		'a$street', 'a$city', 'a$state', 'a$zip'
]
```

The `address` column in the result set is special. It does not carry a value that ends up being set in a resulting record property, but it tells the parser if the `address` nested object property in the resulting record is present. If the value in the column is not `NULL`, a new object is created, set as the value of the parent record `address` property, and the following nested object property columns are parsed. If the value in the `address` column is `NULL`, the `address` nested object property is not set in the Person record.

The `address` nested object property could have further nested object properties, in which case the same markup pattern is repeated recursively adding longer prefixes. Here is a complex example with nested objects:

```javascript
{
	...
	'Person': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'firstName': {
				valueType: 'string'
			},
			'lastName': {
				valueType: 'string'
			},
			'shippingAddress': {
				valueType: 'object',
				properties: {
					'street': {
						valueType: 'string'
					},
					'city': {
						valueType: 'string'
					},
					'state': {
						valueType: 'string'
					},
					'zip': {
						valueType: 'string'
					}
				}
			},
			'paymentInfo': {
				valueType: 'object',
				properties: {
					'ccLast4Digits': {
						valueType: 'string'
					},
					'billingAddress': {
						valueType: 'object',
						properties: {
							'street': {
								valueType: 'string'
							},
							'city': {
								valueType: 'string'
							},
							'state': {
								valueType: 'string'
							},
							'zip': {
								valueType: 'string'
							}
						}
					}
				}
			}
		}
	},
	...
}
```

Then the markup could be:

```javascript
[
	'id', 'firstName', 'lastName', 'shippingAddress',
		'a$street', 'a$city', 'a$state', 'a$zip',
	'paymentInfo',
		'b$ccLast4Digits', 'b$billingAddress',
			'ba$street', 'ba$city', 'ba$state', 'ba$zip'
]
```

Columns `shippingAddress`, `paymentInfo` and `b$billingAddress` are checked by the parser for being `NULL` or not to determine if the corresponding nested object exists.

#### Polymorphic Nested Objects

Similarly to the regular nested object properties, polymorphic nested objects use prefixed nesting levels in the markup. However, an additional nesting level is added between the parent and the level of the object properties. This additional level is used for the subtypes and the name of the corresponding subtype is specified in the column markup instead of the property name. Consider the following example:

```javascript
{
	...
	'Person': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'firstName': {
				valueType: 'string'
			},
			'lastName': {
				valueType: 'string'
			},
			'paymentInfo': {
				valueType: 'object?',
				typePropertyName: 'type',
				subtypes: {
					'CREDIT_CARD': {
						properties: {
							'last4Digits': {
								valueType: 'string'
							},
							'expDate': {
								valueType: 'string'
							}
						}
					},
					'ACH_TRANSFER': {
						properties: {
							'accountType': {
								valueType: 'string'
							},
							'last4Digits': {
								valueType: 'string'
							}
						}
					}
				}
			}
		}
	},
	...
}
```

The markup then could be:

```javascript
[
	'id', 'firstName', 'lastName', 'paymentInfo',
		'a$CREDIT_CARD',
			'aa$last4Digits', 'aa$expDate',
		'a$ACH_TRANSFER',
			'ab$accountType', 'ab$last4Digits'
]
```

The value in the `paymentInfo` column is completely ignored by the parser. It is only used to indicate that the following columns markup is attributed to the `paymentInfo` property. If values in both `a$CREDIT_CARD` and `a$ACH_TRANSFER` columns are `NULL`, the `paymentInfo` property is left unset in the resulting Person record. Otherwise, only one of these columns is allowed to have a non-`NULL` value. An object of that subtype is then created by the parser and the following nested object property columns markup is used to populate it.

For example, if we had the following tables:

```sql
CREATE TABLE persons (
	id INTEGER PRIMARY KEY,
	fname VARCHAR(30),
	lname VARCHAR(30)
);

CREATE TABLE credit_cards (
	person_id INTEGER NOT NULL,
	last4digits CHAR(4),
	expdate CHAR(6),
	UNIQUE (person_id),
	FOREIGN KEY (person_id) REFERENCES persons (id)
);

CREATE TABLE bank_accounts (
	person_id INTEGER NOT NULL,
	accounttype VARCHAR(10),
	last4digits CHAR(4),
	UNIQUE (person_id),
	FOREIGN KEY (person_id) REFERENCES persons (id)
);
```

then a query with embedded markup could be:

```sql
SELECT
	p.id            AS 'id',
	p.fname         AS 'firstName',
	p.lname         AS 'lastName',
	TRUE            AS 'paymentInfo',
	cc.person_id    AS   'a$CREDIT_CARD',
	cc.last4digits  AS     'aa$last4Digits',
	cc.expdate      AS     'aa$expDate',
	ba.person_id    AS   'a$ACH_TRANSFER',
	ba.accounttype  AS     'ab$accountType',
	ba.last4digits  AS     'ab$last4Digits'
FROM
	persons AS p
	LEFT JOIN credit_cards AS cc ON cc.person_id = p.id
	LEFT JOIN bank_accounts AS ba ON ba.person_id = p.id
```

Naturally, the above will work correctly only if a person can have either a single credit card or a single bank account, or none.

#### References

To receive a reference property value, the corresponding result set column value must be the target record id. For example:

```javascript
{
	...
	'Person': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			...
			'locationRef': {
				valueType: 'ref(Location)'
			},
			...
		}
	},
	'Location': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'name': {
				valueType: 'number'
			},
			'latitude': {
				'valueType': 'number'
			},
			'longitude': {
				'valueType': 'number'
			}
		}
	}
	...
}
```

Then a query could be:

```sql
SELECT id, location_id AS locationRef FROM persons
```

This will yield records that look like:

```json
[
  {
    "id": 1,
	"locationRef": "Location#25"
  },
  {
    "id": 2,
	"locationRef": "Location#354"
  }
]
```

What if we also want to fetch the referred location record in the same query? The parser supports it via the *fetched references* feature. To request a fetched reference, the reference property markup must end with a colon. Then, as if it were a nested object, the referred record property columns markup must follow. Here is a query:

```sql
SELECT
	p.id           AS 'id',
	p.location_id  AS 'locationRef:', -- note the colon
	l.id           AS   'a$id',
	l.name         AS   'a$name',
	l.lat          AS   'a$latitude',
	l.lng          AS   'a$longitude'
FROM
	persons AS p
	JOIN locations AS l ON l.id = p.location_id
```

The fetched Location records will end up in the parser's `referredRecords` property, which may look like:

```json
{
  "Location#25": {
    "id": 25,
	"name": "Home",
	"latitude": 51.5074,
	"longitude": 0.1278
  },
  "Location#354": {
    "id": 354,
	"name": "Work",
	"latitude": 40.7128,
	"longitude": 74.0059
  }
}
```

#### Polymorphic References

As with nested objects, the references can be polymoprhic allowing referencing records of different types in the same reference property. The markup syntax for the polymorphic references is similar to that for the polymorphic nested objects. The difference is that instead of subtype names record type names are used in the markup.

For example, given the record type definitions:

```javascript
{
	...
	'Account': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'lastInterestedInRef': {
				valueType: 'ref(Product|Service)'
			}
		}
	},
	'Product': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'name': {
				valueType: 'string'
			},
			'price': {
				valueType: 'number'
			}
		}
	},
	'Service': {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'name': {
				valueType: 'string'
			},
			'rate': {
				valueType: 'number'
			}
	},
	...
}
```

and tables:

```sql
CREATE TABLE products (
	id INTEGER PRIMARY KEY,
	name VARCHAR(50) NOT NULL,
	price DECIMAL(5,2) NOT NULL
);

CREATE TABLE services (
	id INTEGER PRIMARY KEY,
	name VARCHAR(50) NOT NULL,
	rate DECIMAL(5,2) NOT NULL
);

CREATE TABLE accounts (
	id INTEGER PRIMARY KEY,
	-- only one can have value, the other one must be NULL
	interest_product_id INTEGER,
	interest_service_id INTEGER,
	FOREIGN KEY (interest_product_id) REFERENCES products (id),
	FOREIGN KEY (interest_service_id) REFERENCES services (id)
);
```

to fetch accounts with the `lastInterestedInRef` references the query could be:

```sql
SELECT
	id                   AS 'id',
	TRUE                 AS 'lastInterestedInRef',
	interest_product_id  AS   'a$Product',
	interest_service_id  AS   'a$Service'
FROM
	accounts
```

Or, to also fetch the referred Product and Service records:

```sql
SELECT
	a.id                   AS 'id',
	TRUE                   AS 'lastInterestedInRef:', -- note the colon
	a.interest_product_id  AS   'a$Product',
	p.id                   AS     'aa$id',
	p.name                 AS     'aa$name',
	p.price                AS     'aa$price',
	a.interest_service_id  AS   'a$Service',
	s.id                   AS     'ab$id',
	s.name                 AS     'ab$name',
	s.rate                 AS     'ab$rate'
FROM
	accounts AS a
	LEFT JOIN products AS p ON p.id = a.interest_product_id
	LEFT JOIN services AS s ON s.id = a.interest_service_id
```

### Collection Properties

Collection properties, such as arrays and maps, add a completely new level of complexity to the problem of mapping two-dimensional result set grid into the record objects. Unless we want to issue a separate SQL query to fetch collection properties for each record in our main result set, which may prove to be exceptionally inefficient, we want to include the collection values in the same result set with the top records. SQL allows it with table joins, but now in our result set we can't say that each row corresponds to one record. Instead, multiple rows may belong to the same record and what's even worse, we don't know in advance how many rows.

To solve this problem, the `RSParser` introduces the concept of *anchor columns*. The SELECT query then is written in such way that rows that belong to the same record (or nested object) are groupped together in the result set and all share the same value in the anchor column. When the parser progresses through the result set rows, as soon as the value in the anchor column changes it knows that the row belongs to the new object anchored at that column. Every result set has at least one anchor column and that's the first columnn, which contains the top record id. When only scalar properties are used, every row in the result set will have a different record id in the first column and that's why every row results in a new record. However, adding an array property to the result set will result in the parent record properties to be duplicated in the subsequent rows, including the record id, and that is how the parser will know that the rows belong to the same parent record.

Another important concept is a *collection axis*. Because of the way how SQL joins work, it is impossible to select multiple collections on the same nesting level in a single query. Multiple collections can be selected, but only if they lay along a single collection axis. That is a collection of nested objects can have nested properties that are collections themselves and so on. In that case, multiple anchor columns are specified in the markup and a single query can be used. When tree-like data structures need to be loaded from the database with multiple collection properties on the same nesting level, several queries must be used, one for each collection axis, and the parsers can be merged to form the final result. This functionality is discussed later in this manual.

Let's consider different scenarios case by case.

#### Simple Value Arrays and Maps

Given a record type like the following:

```javascript
{
	...
	'Person': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'firstName': {
				valueType: 'string'
			},
			'lastName': {
				valueType: 'string'
			},
			'scores': {
				valueType: '[number]'
			}
		}
	},
	...
}
```

and the tables in the database:

```sql
CREATE TABLE persons (
	id INTEGER PRIMARY KEY,
	fname VARCHAR(30),
	lname VARCHAR(30)
);

CREATE TABLE person_scores (
	person_id INTEGER NOT NULL,
	score DECIMAL(3,1),
	FOREIGN KEY (person_id) REFERENCES persons (id)
);
```

we can fetch records together with the `scores` property using a query like this:

```sql
SELECT
	p.id         AS 'id',
	p.fname      AS 'firstName',
	p.lname      AS 'lastName',
	v.person_id  AS 'scores',
	v.score      AS 'a$'        -- no property name, only prefix
FROM
	persons AS p
	LEFT JOIN person_scores AS v on v.person_id = p.id
ORDER BY
	p.id                        -- group person record rows together
```

Several important notes about the example above:

* Columns that belong to the collection properties *must* always be at the end of the columns list. Given that only one collection property can be fetched at a given nesting level, no column that belongs to the parent object can appear *after* the collection property column and the columns that belong to the collection elements.

* In the example above, the anchor column is the person id column (the first column in the list). The `ORDER BY` clause is used to make sure that rows that belong to the same person record follow each other in an unbroken chunk. As long as the value in the id column does not change, the parser will be adding the values in the `a$` column to the `scores` array on the same person record. As soon as the id changes, it knows that the row now belongs to the next person record.

  In some databases, strictly speaking, there is no need for the `ORDER BY` clause, because it is one of the join side-effects that the rows are grouped by the id, but it is good to have the clause nonetheless to underscore the importance of it. Also, the result set can be ordered using other criteria as well as long as the rows for the same record are still grouped together. For example, if we wanted to sort the person records by last and first name, the clause would be `ORDER BY p.lname, p.fname, p.id`. The id is still needed for cases when the last and first names are identical for different records.

* If the `scores` column contains `NULL`, it means that the person record does not have `scores` property and it is left unset. Note, that if it is `NULL`, only one row belong to the person record and in the next row the person id must change.

* The array value column, which is the last column in the list, has a prefix, which takes to the next nesting level, but does not have a property name, because array elements do not have their own names.

Similarly to an array, a map property is fetched the same way except that the map property column is used for the entry key. The value in the key column must be a string. For example, for a record type:

```javascript
{
	...
	'Person': {
		properties: {
			'id': {
				valueType: 'number',
				role: 'id'
			},
			'firstName': {
				valueType: 'string'
			},
			'lastName': {
				valueType: 'string'
			},
			'scores': {
				valueType: '{number}'
			}
		}
	},
	...
}
```

and the tables:

```sql
CREATE TABLE persons (
	id INTEGER PRIMARY KEY,
	fname VARCHAR(30),
	lname VARCHAR(30)
);

CREATE TABLE person_scores (
	person_id INTEGER NOT NULL,
	class_code VARCHAR(10) NOT NULL,
	score DECIMAL(3,1),
	UNIQUE (person_id, class_code),
	FOREIGN KEY (person_id) REFERENCES persons (id)
);
```

we can fetch records like this:

```sql
SELECT
	p.id         AS 'id',
	p.fname      AS 'firstName',
	p.lname      AS 'lastName',
	v.class_code AS 'scores',   -- this is the map key
	v.score      AS 'a$'
FROM
	persons AS p
	LEFT JOIN person_scores AS v on v.person_id = p.id
ORDER BY
	p.id
```

Note, that in both arrays and maps, if the value column contains `NULL`, an element is still created and its value is set to JavaScript `null`.

#### Nested Object Collections

TODO
