# Nauticus Vision

_Clean-verbatim transcript. Lightly formatted for punctuation and paragraph breaks; product names have been corrected where unambiguous._

## Transcript

The vision for Nauticus is the best way to navigate your tenant as a whole, and the best and fastest way to author Fabric solutions up to gold layer. Its initial focus is very much on a better way to visualise the tenant as a whole.

To do this, it's going to use a map-type visual as its core heart of where everything starts from. The idea behind the map-type visual is using the last 500 years of cartography as inspiration, reducing complex icons and architecture diagrams down to glyphs and map items, taking inspiration from modern mapping tools like Google Maps and others as a way to simplify and show a highly complex environment in a very simple, easy-to-navigate way.

The thinking is that one idea is that it could be similar to railways and stations. Data flows downward, so diagrams can flow downward or left or right. Perhaps we can have two different views. You can switch between left to right and top to bottom, but data flows in one direction like a railway, and it stops in different places like lakehouses and everything—semantic models, et cetera; items, workspaces, domains, et cetera.

You could liken capacities to a country, domains to territories, workspaces to states, items like cities, data flow like roads, overlays like terrain. For example, you might want to set up something like a CU consumption layer based on real-time consumption that you can now bring into Fabric, and that would surface as weather or terrain underneath the map.

To enable it to be the level that we need it to be, it needs to be extremely well considered. It needs very clever filtering to allow adding and removal of layers, simplification, and digging into what you want. It needs the ability to apply the right level of detail depending on zoom.

It needs to support complex tenants that may have multiple capacities, thousands of workspaces, hundreds of thousands of items, but it's no different. This is why the map is such a good starting point. It is no different to mapping a country. There's a huge amount of items and objects.

A key part as well will be turning every single item in Fabric, and some things outside of Fabric like common data source types, which can be represented like SQL, API, et cetera. But designing a glyph library with fantastic glyphs for every single item in Fabric—and I want these not to be just random. They should be a glyph that represents the item. So, you know, a pipeline can look like a pipe, a semantic model can look like some connected tables, but it needs to be very basic. Generally, probably just line-based glyphs.

The legend will be critical as well, showing different types of relationships and boundaries and glyphs. We need probably a dynamic legend that shows only what's visible on the map. And if there's too many things, you know, it allows you to dive deeper rather than just showing lots of information. Cognitive overload is a key consideration.

So the one half of Nauticus is it's the best way to navigate and explore. Your tenant gives you the best visibility of all the key metrics and exactly what's happening across the entire tenant from this map-based view, which starts from the Assess layer that feeds into it all the metrics.

Then the second half that's gated by Pro is authoring. So the authoring experience idea is that you click on a glyph in a map and a side panel pops up with information about that, rich information about it. And from a right-click, you can jump to either on the glyph, from the side panel, or from the tree—a hierarchical tree on the left, which represents the map and the spec that lives underneath the map. From a right-click, you jump to an edit experience.

To start with, the first edit experiences will be pipelines and notebooks. And the key with these is that we will develop a better editing experience than what's available in Fabric itself. To do this, we'll consider the current experience, the pain points, and author something that's more refined for pipelines.

That'll probably mean having things less separate, putting more things in one place, using expansion more dynamically, thinking like, rather than clicking on an item to author in a pipeline and then going through tabs in different areas to see things about it, it can just be expanded and show everything that's required within the same box.

The notebook authoring will do deep research across the best coding tools, best notebook-authoring experiences, bring it all back, and create an ultra-refined notebook experience.

Again, Nauticus shares a lot with Semanticus, as it needs to be designed from the ground up for AI collaboration. The MCP operations need to be carefully designed because they're a key differentiator in the difference between our tool and just throwing AI at Fabric.

There's a Microsoft MCP already, which allows item creation, which we need to look at, see if it's open source, see if we can use it. It defines schemas for items, which is very useful, and has API recommendations. It's a very good starting point if we can use it.

We also want to do a similar thing to Semanticus, where we allow creation of items and operations from the MCP, combined with Claude instructions, gates, verifications, evidence, user inputs, and basically build a graph-engineering interface that's similar to the pipeline-building interface that you find in ADF or Fabric pipelines.

Another critical thing is that we can't have the two tools develop independently. They need to share assets. So if we do a whole bunch of work on connections, for example, in Semanticus, we shouldn't redesign a connections manager for Nauticus; we should use the same connections manager. If we design a graph-engineering interface for Semanticus, we shouldn't design a new one for Nauticus. So we need to think carefully about the co-development of the tools, how they align.
